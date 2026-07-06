import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  buildServerArgs,
  buildInferenceBody,
  parseInferenceResponse,
  pickThreads,
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
  binaryPath: string;
  modelPath: string;
  language?: string; // "auto" lets the model detect French/English per utterance
  log?: (msg: string) => void;
}

export class WhisperSidecar {
  private proc: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private opts: SidecarOptions;

  constructor(opts: SidecarOptions) {
    this.opts = opts;
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
    if (!fs.existsSync(this.opts.binaryPath))
      throw new Error(`whisper-server binary missing: ${this.opts.binaryPath}`);
    if (!fs.existsSync(this.opts.modelPath))
      throw new Error(`ASR model missing: ${this.opts.modelPath}`);
    this.stopped = false;
    this.port = await findFreePort(PORT_START, PORT_END);
    const args = buildServerArgs(
      this.opts.modelPath,
      this.port,
      pickThreads(os.cpus().length),
    );
    const proc = spawn(this.opts.binaryPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    proc.stderr?.on("data", (d: Buffer) => {
      // whisper-server logs to stderr; keep the tail visible in dev only.
      this.opts.log?.(`[whisper-server] ${String(d).trim().slice(0, 300)}`);
    });
    proc.on("exit", (code) => {
      this.proc = null;
      this.port = 0;
      // A crash of the warm server must not kill dictation for the session:
      // the next transcribe() re-runs ensureStarted() and respawns it.
      if (!this.stopped) this.opts.log?.(`[whisper-server] exited (${code}); will respawn on next use`);
    });
    this.proc = proc;
    await this.waitReady();
    this.opts.log?.(`[whisper-server] warm on 127.0.0.1:${this.port}`);
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
    this.stop();
    throw new Error("whisper-server did not become ready in 30 s (model load)");
  }

  /** One utterance in, clean text out. The WAV is never written anywhere. */
  async transcribe(wav: Uint8Array): Promise<{ text: string; ms: number }> {
    await this.ensureStarted();
    const started = Date.now();
    const boundary = "agrflow-" + crypto.randomBytes(12).toString("hex");
    const body = buildInferenceBody(boundary, wav, this.opts.language ?? "auto");
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
