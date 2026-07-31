import { childEnv } from "../../shared/childEnv";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildServerArgs,
  buildInferenceBody,
  parseInferenceResponse,
  pickThreads,
  computeAudioCtx,
  wavDurationSec,
} from "./protocol";

// The ASR sidecar: whisper.cpp's whisper-server kept WARM on loopback. The
// model loads once at startup; each utterance is a single POST /inference.
// That warm pattern (proved by OpenWhispr) is the backbone of the "text the
// instant you release" goal - a cold model load per utterance costs seconds.
//
// Deliberately Electron-free: paths come in through the constructor, so the
// exact class can be exercised end-to-end outside the app (tests, benches).

const PORT_START = 8178;
const PORT_END = 8199;
const STARTUP_TIMEOUT_MS = 30_000;
const INFERENCE_TIMEOUT_MS = 60_000;

export interface SidecarOptions {
  /** Ordered whisper-server candidates (v5 c1: Vulkan GPU build first, CPU build
   * as the universal fallback). The first that becomes ready is frozen for the
   * session; a missing or GPU-less machine simply falls through to the next. */
  binaryPaths: string[];
  modelPath: string;
  language?: string; // "auto" lets the model detect French/English per utterance
  beamSize?: number; // whisper-server --beam-size (plan v4 c11: accuracy lever)
  /** A French initial prompt (plan v4 c11), sent per request ONLY when the
   * effective language is French or auto, to bias accents/casing/punctuation.
   *
   * U6b: may be a FUNCTION, resolved per request, because the prompt now also
   * carries the user's starred dictionary terms (storey 1) and that list
   * changes while the app runs - a string captured when the sidecar was built
   * would go stale the moment a term is added, and would not come back until
   * the next model swap. The callee (main/dictionary.ts's dictationPrompt)
   * returns a CACHED string and never throws: this is the inference path, and
   * it must not be able to cost the user his utterance. */
  initialPrompt?: string | (() => string);
  /** R1: a short known-speech WAV. When set, a backend must actually DECODE it to
   * non-empty text before it is trusted (freezes it); a Vulkan build that loads but
   * cannot decode (weak/quirky GPU) is skipped in favour of CPU at SELECTION time.
   * Absent (e.g. in unit tests) = the readiness GET is the only gate, as before. */
  probeWav?: Uint8Array;
  /** Tests only: inject a fake process spawner so backend selection and the
   * inference-time fallback can be exercised without real whisper-server binaries. */
  spawnProc?: (command: string, args: string[]) => ChildProcess;
  log?: (msg: string) => void;
  /** Engine state for the tray: "warm" = ready, "down" = (re)starting, "error" = gave up.
   * R1: `detail` carries a human-readable reason (which backend, why) so a build with no
   * dev console can still surface it (statusText / log file / Manager). */
  onState?: (state: "warm" | "down" | "error", detail?: string) => void;
}

// Watchdog guard: a crash-looping server (bad model, OOM) must not respawn
// forever. Past this many auto-respawns in the window, we stop trying eagerly
// (a later transcribe() still attempts a lazy start).
const RESPAWN_MAX = 3;
const RESPAWN_WINDOW_MS = 5 * 60_000;
const RESPAWN_DELAY_MS = 1_000;
// R1: the decode probe (real inference of a known WAV) runs AFTER the model has
// loaded (readiness already passed), so it is normally fast; a generous cap still
// lets a slow CPU load finish while catching a GPU that hangs on inference.
const PROBE_TIMEOUT_MS = 30_000;
// R1: after this many consecutive EMPTY results during DICTATION (the "animation
// plays but nothing writes" symptom), the current backend is demoted and the next
// candidate (CPU) takes over. Empty dictations in a row are essentially never
// legitimate (the energy VAD already dropped true silence before we got here), so
// 3 is low enough to self-heal a broken backend after only a couple of dead
// utterances, yet not so twitchy that a lone fluke demotes a healthy GPU.
const EMPTY_DEMOTE_STREAK = 3;

export class WhisperSidecar {
  private proc: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private respawns: number[] = []; // timestamps of recent auto-respawns
  private binPath = ""; // the backend that became ready (frozen for respawns); "" while (re)selecting
  private badBackends = new Set<string>(); // R1: backends that failed the probe or degraded at inference
  private emptyStreak = 0; // R1: consecutive empty results on the frozen backend
  private opts: SidecarOptions;

  constructor(opts: SidecarOptions) {
    this.opts = opts;
  }

  /** Applied to the NEXT inference; the language is a per-request field. */
  setLanguage(language: string) {
    this.opts.language = language;
  }

  /** Idempotent warm-up; concurrent callers share the same startup. */
  ensureStarted(): Promise<void> {
    if (this.proc && this.port) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!fs.existsSync(this.opts.modelPath))
      throw new Error(`ASR model missing: ${this.opts.modelPath}`);
    this.stopped = false;
    // Respawn of an already-chosen backend: reuse it directly (no re-probe).
    if (this.binPath) return this.startWith(this.binPath, false);
    // First start / after a demotion: try the candidates in order (Vulkan GPU ->
    // CPU fallback), skipping any backend already known bad (probe/inference failure).
    const cands = this.opts.binaryPaths.filter((b) => fs.existsSync(b) && !this.badBackends.has(b));
    if (!cands.length) {
      throw new Error(
        this.badBackends.size
          ? "every whisper-server backend failed (GPU and CPU); check the model and the GPU drivers"
          : "no whisper-server binary present",
      );
    }
    let lastErr: unknown;
    for (let i = 0; i < cands.length; i++) {
      const bin = cands[i];
      // R1 (review fix): the decode probe only makes sense when there is ANOTHER
      // backend to fall back to. On the LAST/sole candidate it can only hurt - a slow
      // CPU decode of the big model can exceed the probe timeout and would then mark
      // the only working backend bad, bricking dictation. So the last candidate is
      // trusted on readiness alone (the inference-time fallback still guards runtime).
      const probe = i < cands.length - 1;
      try {
        await this.startWith(bin, probe); // freezes binPath + (maybe) runs the decode probe
        return;
      } catch (e) {
        lastErr = e;
        this.badBackends.add(bin); // do not retry a backend that could not start or decode
        this.opts.log?.(`[whisper-server] ${path.basename(bin)} unavailable (${e}); trying next backend`);
      }
    }
    throw lastErr ?? new Error("no whisper-server backend could start");
  }

  /** Spawn ONE binary, wait for readiness, and (when `probe` and a fallback exists)
   * require it to actually DECODE the probe WAV. During this trial the exit only
   * clears state (no respawn); the respawn watchdog is attached only once trusted. */
  private async startWith(bin: string, probe: boolean): Promise<void> {
    this.port = await findFreePort(PORT_START, PORT_END);
    const args = buildServerArgs(
      this.opts.modelPath,
      this.port,
      pickThreads(os.cpus().length),
      { beamSize: this.opts.beamSize },
    );
    const proc = this.opts.spawnProc
      ? this.opts.spawnProc(bin, args)
      : spawn(bin, args, {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          // 2026-07-31: without this the sidecar inherited every credential the
          // user had exported. A transcription binary has no use for any of them.
          env: childEnv(),
        });
    proc.stderr?.on("data", (d: Buffer) => {
      // whisper-server logs to stderr; route the tail to the log (file in prod).
      this.opts.log?.(`[whisper-server] ${String(d).trim().slice(0, 300)}`);
    });
    // Guard on identity: a demotion/respawn can leave an OLD proc's delayed exit
    // event to fire AFTER a newer proc was installed; it must not clobber the new one.
    const onTrialExit = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.port = 0;
    };
    proc.on("exit", onTrialExit);
    this.proc = proc;
    try {
      await this.waitReady();
      // R1: real decode gate, ONLY when a fallback backend exists (never on the last
      // candidate) and never on a plain respawn of the already-trusted winner.
      if (probe && this.opts.probeWav) await this.decodeProbe(bin);
    } catch (e) {
      proc.removeListener("exit", onTrialExit);
      this.hardStopProc();
      throw e;
    }
    // Trusted: freeze the winner BEFORE attaching the watchdog (so onRunningExit,
    // which bails when binPath is "", never fires against an unfrozen backend).
    this.binPath = bin;
    this.emptyStreak = 0;
    proc.removeListener("exit", onTrialExit);
    proc.on("exit", (code) => this.onRunningExit(proc, code));
    this.opts.log?.(`[whisper-server] backend ${path.basename(bin)} warm on 127.0.0.1:${this.port}`);
    this.opts.onState?.("warm", `speech backend: ${path.basename(bin)}`);
  }

  /** R1: POST the known probe WAV and require non-empty text. A GPU build that loads
   * but returns nothing (or hangs) fails here and the caller falls back to CPU. */
  private async decodeProbe(bin: string): Promise<void> {
    const { text } = await this.inferOnce(this.opts.probeWav!, PROBE_TIMEOUT_MS);
    if (text.trim().length === 0) {
      throw new Error(`${path.basename(bin)} loaded but decoded no text (unusable GPU build?)`);
    }
    this.opts.log?.(`[whisper-server] ${path.basename(bin)} decode probe OK`);
  }

  // Watchdog (plan 5.9): a crash of the WARM server must not kill dictation for
  // the session. Respawn eagerly (the chosen backend), with a crash-loop guard.
  private onRunningExit(proc: ChildProcess, code: number | null) {
    // A stale exit from an OLD backend (demoted/replaced) must not touch the state of
    // the newer proc that has since taken over.
    if (this.proc !== proc) return;
    this.proc = null;
    this.port = 0;
    if (this.stopped) return;
    // R1: a demotion cleared binPath and is driving the switch to the next backend;
    // do NOT eagerly respawn the (now bad) one here.
    if (!this.binPath) return;
    this.opts.log?.(`[whisper-server] exited (${code})`);
    const now = Date.now();
    this.respawns = this.respawns.filter((t) => now - t < RESPAWN_WINDOW_MS);
    if (this.respawns.length >= RESPAWN_MAX) {
      this.opts.log?.("[whisper-server] crash-looping; eager respawn paused");
      this.opts.onState?.("error");
      return;
    }
    this.respawns.push(now);
    this.opts.onState?.("down");
    setTimeout(() => {
      if (!this.stopped && !this.proc) {
        this.ensureStarted().catch((e) => this.opts.log?.(`[whisper-server] respawn failed: ${e}`));
      }
    }, RESPAWN_DELAY_MS);
  }

  private hardStopProc() {
    try {
      this.proc?.kill();
    } catch {
      /* best effort */
    }
    this.proc = null;
    this.port = 0;
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error("whisper-server died during startup");
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(
          { hostname: "127.0.0.1", port: this.port, path: "/", timeout: 1500 },
          (res) => {
            res.resume();
            resolve(res.statusCode !== undefined);
          },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    // Kill only this proc (NOT this.stop(), which would set stopped and block a
    // fallback to the next backend); the caller decides whether to try another.
    this.hardStopProc();
    throw new Error("whisper-server did not become ready in 30 s (model load)");
  }

  /** One utterance in, clean text out. The WAV is never written anywhere.
   * R1: layered recovery - (1) if the warm server died mid-flight, one respawn+retry
   * on the SAME backend; (2) if that still fails, or the frozen backend keeps
   * returning EMPTY on voiced speech, demote it and re-run on the next backend (CPU).
   * So "the animation plays but nothing writes" self-heals to CPU instead of staying
   * silent forever. */
  async transcribe(wav: Uint8Array, opts: { allowEmptyDemote?: boolean } = {}): Promise<{ text: string; ms: number }> {
    // Empty text is a reliable "this backend is broken" signal ONLY for dictation
    // (the user definitely spoke). For long-form auto-segments an empty is often
    // GENUINE non-speech (music, applause, ambience); demoting a healthy GPU on that
    // is a silent speed regression, so the long-form caller opts out (hard failures
    // still demote either way).
    const allowEmptyDemote = opts.allowEmptyDemote !== false;
    let r: { text: string; ms: number };
    try {
      r = await this.attemptInfer(wav);
    } catch (err) {
      if (this.stopped || !this.hasFallbackBackend()) throw err;
      this.demote(`inference failed (${err})`);
      return await this.attemptInfer(wav); // on the next backend (CPU)
    }
    if (r.text.trim().length === 0) {
      if (allowEmptyDemote) {
        this.emptyStreak++;
        if (this.emptyStreak >= EMPTY_DEMOTE_STREAK && this.hasFallbackBackend()) {
          this.demote(`${this.emptyStreak} empty results in a row`);
          this.emptyStreak = 0;
          return await this.attemptInfer(wav); // re-decode this utterance on CPU
        }
      }
    } else {
      this.emptyStreak = 0;
    }
    return r;
  }

  /** One inference with a single same-backend respawn+retry on a mid-flight death. */
  private async attemptInfer(wav: Uint8Array): Promise<{ text: string; ms: number }> {
    try {
      return await this.inferOnce(wav);
    } catch (err) {
      if (this.stopped) throw err;
      this.opts.log?.(`[whisper-server] inference failed (${err}); one retry`);
      this.proc?.kill();
      this.proc = null;
      this.port = 0;
      return await this.inferOnce(wav);
    }
  }

  /** R1: is there another usable backend to fall back to (present, not already bad,
   * not the one currently frozen)? */
  private hasFallbackBackend(): boolean {
    return this.opts.binaryPaths.some(
      (b) => b !== this.binPath && fs.existsSync(b) && !this.badBackends.has(b),
    );
  }

  /** R1: mark the current backend bad, unfreeze, and kill it. binPath="" makes
   * onRunningExit stand down; the next ensureStarted() re-selects (-> CPU). */
  private demote(reason: string): void {
    const was = this.binPath;
    if (was) this.badBackends.add(was);
    this.opts.log?.(`[whisper-server] demoting ${path.basename(was)}: ${reason}`);
    this.opts.onState?.("down", `switching speech backend (${path.basename(was)}: ${reason})`);
    this.binPath = "";
    this.hardStopProc();
  }

  private async inferOnce(wav: Uint8Array, timeoutMs = INFERENCE_TIMEOUT_MS): Promise<{ text: string; ms: number }> {
    await this.ensureStarted();
    const started = Date.now();
    const boundary = "agrflow-" + crypto.randomBytes(12).toString("hex");
    const lang = this.opts.language ?? "auto";
    // v5 c1: the French seed rides ONLY for an explicit French language (not auto), so it
    // never bleeds its vocabulary into a short clip that turned out to be another language.
    // U6b: that same guard is now also what keeps the DICTIONARY out of a clip
    // whose language nobody declared - the widest leak surface storey 1 has.
    const prompt =
      lang === "fr"
        ? typeof this.opts.initialPrompt === "function"
          ? this.opts.initialPrompt()
          : this.opts.initialPrompt
        : undefined;
    // v5 c1: audio_ctx shrinking is a SPEED trick calibrated on `small`; it garbles bigger
    // models (turbo/large) - the root cause of the "horrible" French. Truncate only for small;
    // every other model omits the field so whisper-server uses its full encoder context.
    const isSmall = /small/i.test(path.basename(this.opts.modelPath));
    const audioCtx = isSmall ? computeAudioCtx(wavDurationSec(wav.length)) : undefined;
    const body = buildInferenceBody(boundary, wav, lang, audioCtx, prompt);
    const raw = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/inference",
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode !== 200)
              reject(new Error(`whisper-server ${res.statusCode}: ${data.slice(0, 200)}`));
            else resolve(data);
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("whisper-server inference timed out"));
      });
      req.write(body);
      req.end();
    });
    return { text: parseInferenceResponse(raw), ms: Date.now() - started };
  }

  /** R1: the backend currently in use ("" while (re)selecting), for the status surface. */
  activeBackend(): string {
    return this.binPath;
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
    this.port = 0;
  }
}

function findFreePort(from: number, to: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > to) return reject(new Error("no free port for whisper-server"));
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(p)));
    };
    tryPort(from);
  });
}
