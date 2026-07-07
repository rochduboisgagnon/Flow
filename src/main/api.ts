import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./settings";

// AGR Flow's local API (plan 7.2): how the rest of the AGR ecosystem talks to
// the app WITHOUT reimplementing it. AGR Pilot's PWA posts phone-recorded
// audio to /transcribe (its mic button); AGR Manager polls /update-readiness
// for the quiet window before swapping binaries (plan 8).
//
// Loopback ONLY, like the ASR sidecar: nothing is ever reachable from the
// network. Discovery is a tiny ~/.agr-flow/api.json (port + pid) the sibling
// apps on this machine read - no scanning, no registry.
//
// Zero retention holds here too: /transcribe audio lives for one inference
// and dies; nothing is logged, nothing is stored.

const PORTS = [8176, 8296, 8396]; // stay clear of whisper-server's 8178-8199
const MAX_AUDIO_BYTES = 64 * 1024 * 1024; // ~35 min of 16 kHz WAV, ample for dictation

export interface ApiDeps {
  version: string;
  isListening(): boolean;
  isRecording(): boolean; // long-form capture (phase 4)
  isEngineWarm(): boolean;
  /** Runs the production pipeline: VAD gate -> ASR -> hallucination gate ->
   * optional cleanup. Empty text = gated silence. */
  transcribe(wav: Uint8Array, cleanup: boolean): Promise<{ text: string; ms: number }>;
  /** Tests only: redirect the discovery file away from the real ~/.agr-flow. */
  infoPathOverride?: string;
}

export function apiInfoPath(): string {
  return path.join(dataDir(), "api.json");
}

export class LocalApi {
  private server: http.Server | null = null;
  private port = 0;
  private deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    for (const port of PORTS) {
      try {
        await this.listen(port);
        this.port = port;
        break;
      } catch {
        /* busy: try the next candidate */
      }
    }
    if (!this.port) throw new Error("no free port for the AGR Flow API");
    const info = this.deps.infoPathOverride ?? apiInfoPath();
    fs.mkdirSync(path.dirname(info), { recursive: true });
    fs.writeFileSync(
      info,
      JSON.stringify({ app: "agr-flow", port: this.port, pid: process.pid, version: this.deps.version }),
    );
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.route(req, res));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.server = server;
        resolve();
      });
    });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (code: number, body: unknown) => {
      const data = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    };
    try {
      if (req.method === "GET" && url.pathname === "/status") {
        return json(200, {
          app: "agr-flow",
          version: this.deps.version,
          engineWarm: this.deps.isEngineWarm(),
          listening: this.deps.isListening(),
          recording: this.deps.isRecording(),
        });
      }
      if (req.method === "GET" && url.pathname === "/update-readiness") {
        // The Manager's quiet window (plan 8): never swap binaries while a
        // dictation or a long recording is in flight.
        const ready = !this.deps.isListening() && !this.deps.isRecording();
        return json(200, { ready });
      }
      if (req.method === "POST" && url.pathname === "/transcribe") {
        const chunks: Buffer[] = [];
        let size = 0;
        await new Promise<void>((resolve, reject) => {
          req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_AUDIO_BYTES) {
              reject(new Error("audio too large"));
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          req.on("end", resolve);
          req.on("error", reject);
        });
        const wav = new Uint8Array(Buffer.concat(chunks));
        const cleanup = url.searchParams.get("cleanup") === "1";
        const out = await this.deps.transcribe(wav, cleanup);
        return json(200, out);
      }
      json(404, { error: "not found" });
    } catch (err) {
      json(500, { error: String(err) });
    }
  }

  stop() {
    this.server?.close();
    this.server = null;
    const info = this.deps.infoPathOverride ?? apiInfoPath();
    try {
      // Only remove our own discovery file (a newer instance may own it).
      const raw = JSON.parse(fs.readFileSync(info, "utf8")) as { pid?: number };
      if (raw.pid === process.pid) fs.unlinkSync(info);
    } catch {
      /* absent or unreadable: nothing to clean */
    }
  }
}
