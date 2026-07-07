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
  // Long-form mode (plan §6/§7.2b), driven remotely by AGR Pilot's PWA page.
  // The AUDIO comes from the recording DEVICE (phone or PC browser) through
  // /long/chunk (plan v2 chantier C) - AGR Flow never opens a mic for it.
  longState(): unknown;
  longStart(opts: { dir: string; title?: string; template?: string }): unknown;
  longStop(): unknown;
  longMark(): unknown;
  longChunk(pcm: Int16Array): unknown;
  longGap(seconds: number): unknown;
  // Settings surface (plan v2 chantier A): AGR Flow is headless; AGR Manager's
  // AGR Flow view is the ONLY user-facing settings UI and drives it through
  // these endpoints.
  getSettings(): unknown;
  setSettings(patch: Record<string, unknown>): unknown;
  recordShortcut(): Promise<unknown>;
  listMics(): Promise<unknown>;
  ollamaModels(): Promise<unknown>;
  quit(): void;
  /** Tests only: redirect the discovery file away from the real ~/.agr-flow. */
  infoPathOverride?: string;
}

export function apiInfoPath(): string {
  return path.join(dataDir(), "api.json");
}

/** Small JSON body reader (loopback control endpoints only). */
function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
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
      // ---- settings surface for the Manager (headless engine, chantier A) ----
      if (req.method === "GET" && url.pathname === "/settings") {
        return json(200, this.deps.getSettings());
      }
      if (req.method === "POST" && url.pathname === "/settings") {
        const body = await readJson(req);
        return json(200, this.deps.setSettings(body ?? {}));
      }
      if (req.method === "POST" && url.pathname === "/shortcut/record") {
        // Long-poll by design: resolves when the user finishes the gesture
        // (or the 10 s recorder timeout fires).
        return json(200, await this.deps.recordShortcut());
      }
      if (req.method === "GET" && url.pathname === "/mics") {
        return json(200, await this.deps.listMics());
      }
      if (req.method === "GET" && url.pathname === "/ollama/models") {
        return json(200, { models: await this.deps.ollamaModels() });
      }
      if (req.method === "POST" && url.pathname === "/quit") {
        json(200, { ok: true });
        this.deps.quit();
        return;
      }
      // ---- long-form mode: state / start / stop / mark ----
      if (req.method === "GET" && url.pathname === "/long/state") {
        return json(200, this.deps.longState());
      }
      if (req.method === "POST" && url.pathname === "/long/start") {
        const body = await readJson(req);
        const dir = typeof body?.dir === "string" ? body.dir : "";
        if (!dir) return json(400, { ok: false, error: "missing dir" });
        return json(200, this.deps.longStart({
          dir,
          title: typeof body?.title === "string" ? body.title : undefined,
          template: typeof body?.template === "string" ? body.template : undefined,
        }));
      }
      if (req.method === "POST" && url.pathname === "/long/stop") {
        return json(200, this.deps.longStop());
      }
      if (req.method === "POST" && url.pathname === "/long/mark") {
        return json(200, this.deps.longMark());
      }
      if (req.method === "POST" && url.pathname === "/long/chunk") {
        // Raw Int16 mono 16 kHz PCM slice (a few seconds), relayed by the
        // Pilot server from the recording device. Bounded well above the
        // normal ~160 KB per 5 s slice.
        const chunks: Buffer[] = [];
        let size = 0;
        await new Promise<void>((resolve, reject) => {
          req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 8 * 1024 * 1024) {
              reject(new Error("chunk too large"));
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          req.on("end", resolve);
          req.on("error", reject);
        });
        const buf = Buffer.concat(chunks);
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
        return json(200, this.deps.longChunk(pcm.slice(0)));
      }
      if (req.method === "POST" && url.pathname === "/long/gap") {
        const body = await readJson(req);
        const seconds = typeof body?.seconds === "number" ? body.seconds : 0;
        return json(200, this.deps.longGap(seconds));
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
