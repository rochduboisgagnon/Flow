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
   * effective language is French or auto, to bias accents/casing/punctuation. */
  initialPrompt?: string;
  log?: (msg: string) => void;
  /** Engine state for the tray: "warm" = ready, "down" = (re)starting, "error" = gave up. */
  onState?: (state: "warm" | "down" | "error") => void;
}

// Watchdog guard: a crash-looping server (bad model, OOM) must not respawn
// forever. Past this many auto-respawns in the window, we stop trying eagerly
// (a later transcribe() still attempts a lazy start).
const RESPAWN_MAX = 3;
const RESPAWN_WINDOW_MS = 5 * 60_000;
const RESPAWN_DELAY_MS = 1_000;

export class WhisperSidecar {
  private proc: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private respawns: number[] = []; // timestamps of recent auto-respawns
  private binPath = ""; // the backend that became ready (frozen for respawns)
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
    // Respawn of an already-chosen backend: reuse it directly.
    if (this.binPath) return this.startWith(this.binPath);
    // First start: try the candidates in order (Vulkan GPU -> CPU fallback).
    const cands = this.opts.binaryPaths.filter((b) => fs.existsSync(b));
    if (!cands.length) throw new Error("no whisper-server binary present");
    let lastErr: unknown;
    for (const bin of cands) {
      try {
        await this.startWith(bin);
        this.binPath = bin; // freeze the winner for the session
        this.opts.log?.(`[whisper-server] backend: ${path.basename(bin)}`);
        return;
      } catch (e) {
        lastErr = e;
        this.opts.log?.(`[whisper-server] ${path.basename(bin)} unavailable (${e}); trying next backend`);
      }
    }
    throw lastErr ?? new Error("no whisper-server backend could start");
  }

  /** Spawn ONE binary and wait for readiness. During this trial the exit only
   * clears state (no respawn); the respawn watchdog is attached only once warm. */
  private async startWith(bin: string): Promise<void> {
    this.port = await findFreePort(PORT_START, PORT_END);
    const args = buildServerArgs(
      this.opts.modelPath,
      this.port,
      pickThreads(os.cpus().length),
      { beamSize: this.opts.beamSize },
    );
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    proc.stderr?.on("data", (d: Buffer) => {
      // whisper-server logs to stderr; keep the tail visible in dev only.
      this.opts.log?.(`[whisper-server] ${String(d).trim().slice(0, 300)}`);
    });
    const onTrialExit = () => {
      this.proc = null;
      this.port = 0;
    };
    proc.on("exit", onTrialExit);
    this.proc = proc;
    try {
      await this.waitReady();
    } catch (e) {
      proc.removeListener("exit", onTrialExit);
      this.hardStopProc();
      throw e;
    }
    // Warm: swap the trial listener for the respawn watchdog.
    proc.removeListener("exit", onTrialExit);
    proc.on("exit", (code) => this.onRunningExit(code));
    this.opts.log?.(`[whisper-server] warm on 127.0.0.1:${this.port}`);
    this.opts.onState?.("warm");
  }

  // Watchdog (plan 5.9): a crash of the WARM server must not kill dictation for
  // the session. Respawn eagerly (the chosen backend), with a crash-loop guard.
  private onRunningExit(code: number | null) {
    this.proc = null;
    this.port = 0;
    if (this.stopped) return;
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
   * If the warm server died mid-flight, ONE respawn+retry; a second failure
   * surfaces (and the loop inserts nothing - never text from a broken run). */
  async transcribe(wav: Uint8Array): Promise<{ text: string; ms: number }> {
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

  private async inferOnce(wav: Uint8Array): Promise<{ text: string; ms: number }> {
    await this.ensureStarted();
    const started = Date.now();
    const boundary = "agrflow-" + crypto.randomBytes(12).toString("hex");
    const lang = this.opts.language ?? "auto";
    // v5 c1: the French seed rides ONLY for an explicit French language (not auto), so it
    // never bleeds its vocabulary into a short clip that turned out to be another language.
    const prompt = lang === "fr" ? this.opts.initialPrompt : undefined;
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
          timeout: INFERENCE_TIMEOUT_MS,
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
