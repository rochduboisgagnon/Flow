import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./settings";
import type { HistoryItem, HistoryDocPayload } from "./longform";

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
  /** Engine log (flowLog); optional so pure tests need not provide one. */
  log?(msg: string): void;
  /** Update-readiness beyond listening/recording (model download in flight...).
   * Optional: absent means the two flags above are the whole story. */
  isUpdateBusy?(): boolean;
  isListening(): boolean;
  isRecording(): boolean; // long-form capture (phase 4)
  isEngineWarm(): boolean;
  canLoopback(): boolean; // C2: engine can capture the PC's own sound natively (Windows)
  /** Runs the production pipeline: VAD gate -> ASR -> hallucination gate.
   * Empty text = gated silence. */
  transcribe(wav: Uint8Array): Promise<{ text: string; ms: number }>;
  // Long-form mode (plan §6/§7.2b), driven remotely by AGR Pilot's PWA page.
  // The AUDIO comes from the recording DEVICE (phone or PC browser) through
  // /long/chunk (plan v2 chantier C) - AGR Flow never opens a mic for it.
  longState(): unknown;
  longStart(opts: { dir?: string; title?: string; keepAudio?: boolean }): unknown;
  // C2 (Windows-only): the ENGINE captures the PC's own sound + the mic natively
  // (no picker, no PWA audio). The PWA is only a remote control + live transcript.
  longStartNative(opts: { title?: string; keepAudio?: boolean; captureSystem?: boolean }): unknown;
  longStop(): unknown;
  longSave(dir: string): unknown; // v6 c7: file the finished recording at Stop
  // Meeting notes (2026-07-21): the Pilot server GENERATES the notes (Claude,
  // on its side); the engine only does the WRITE, so save() and the splice can
  // never tear the document between two processes.
  longNotesSplice(docPath: string, notes: string): unknown;
  longMark(): unknown;
  longChunk(pcm: Int16Array): unknown;
  longGap(seconds: number): unknown;
  longTranscript(since: number): unknown;
  // Archive 2026-07-14: recording history browser (C10's history folder, now
  // readable from the PWA, and U5a's UI_HISTORY_* IPC channels). listHistory
  // re-enumerates the real dirs on every call; resolveHistoryEntry turns an
  // opaque id back into on-disk paths, or null if the id is forged/stale (see
  // longform.ts for the path-safety). readHistoryDoc is the ONE
  // implementation behind both this route and UI_HISTORY_DOC (U5a) - never a
  // second copy of the resolve+read+cap logic.
  listHistory(): HistoryItem[];
  resolveHistoryEntry(id: string): { dir: string; doc: string | null; audio: string | null } | null;
  readHistoryDoc(id: string): HistoryDocPayload | null;
  // Settings surface (plan v2 chantier A): AGR Flow is headless; AGR Manager's
  // AGR Flow view is the ONLY user-facing settings UI and drives it through
  // these endpoints.
  getSettings(): unknown;
  setSettings(patch: Record<string, unknown>): unknown;
  recordShortcut(): Promise<unknown>;
  listMics(): Promise<unknown>;
  ollamaModels(): Promise<unknown>;
  /** B1: read-only snapshot of the activation hot-path ring (src/shared/hotpath.ts).
   * Timings, step names and small counts only - never dictated content (see
   * hotpath.ts's zero-retention note). This is what `npm run bench:hotpath`
   * reads from a running app, and what the Diagnostics panel polls over IPC
   * (same closure, see index.ts's hotpathSnapshotDep). */
  hotpathSnapshot(): unknown;
  /** B5: the six-line self-diagnostic (src/shared/selfCheck.ts). Same closure
   * the UI_SELF_CHECK IPC channel calls (index.ts's selfCheckDep), so a support
   * request read over loopback and the Diagnostics panel can never disagree.
   * States, counts, a port, a model file name and a folder path - never
   * dictated content. */
  selfCheck(): Promise<unknown>;
  quit(): void;
  /** Tests only: redirect the discovery file away from the real ~/.agr-flow. */
  infoPathOverride?: string;
}

export function apiInfoPath(): string {
  return path.join(dataDir(), "api.json");
}

/** process.kill(pid, 0) probe; EPERM = exists but not ours = alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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

  /** The bound loopback port (0 until start() succeeds). Shown in Diagnostics. */
  boundPort(): number {
    return this.port;
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
    // Review A10 (critical): while the 1.0.0 migration is deferred, dataDir()
    // still points at the OLD engine's folder - and its api.json is the ONLY
    // record the migration has of that live process. Overwriting it here would
    // erase the very evidence the next boot needs (and then trust its own file
    // as proof that "nothing runs"). A discovery file advertising a LIVE pid
    // that is not us is therefore left alone: sibling apps keep discovering the
    // old engine, and we run this session without a discovery file - a lesser
    // harm than a folder rename under a running app.
    try {
      const raw = JSON.parse(fs.readFileSync(info, "utf8")) as { pid?: number };
      if (typeof raw.pid === "number" && raw.pid !== process.pid && pidAlive(raw.pid)) {
        this.deps.log?.(`[api] not overwriting ${info}: it advertises live pid ${raw.pid} (the previous engine)`);
        return;
      }
    } catch {
      /* absent or unreadable: ours to write */
    }
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
    // CSRF / drive-by guard (audit 2026-07-11, S1). The ports are fixed and enumerable, so any web
    // page the user opens could otherwise POST /quit, /long/start, /settings... to this loopback API
    // (a CORS "simple" request needs no preflight). The sibling apps (AGR Pilot server, AGR Manager)
    // call it SERVER-TO-SERVER and never set Origin or any Sec-Fetch-* header; a browser ALWAYS sets
    // them on a cross-origin request (and this API serves no HTML, so every browser request to it is
    // cross-origin). So on any state-changing method we refuse a request that carries either header.
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers["origin"] !== undefined || req.headers["sec-fetch-site"] !== undefined) {
        return json(403, { error: "cross-origin request refused (loopback control API)" });
      }
    }
    try {
      if (req.method === "GET" && url.pathname === "/status") {
        return json(200, {
          app: "agr-flow",
          version: this.deps.version,
          engineWarm: this.deps.isEngineWarm(),
          listening: this.deps.isListening(),
          recording: this.deps.isRecording(),
          canLoopback: this.deps.canLoopback(), // C2
        });
      }
      // B1: read-only, GET, same trust level as /status and /settings below -
      // loopback-only and content-free by construction (see hotpath.ts).
      if (req.method === "GET" && url.pathname === "/diagnostics/hotpath") {
        return json(200, this.deps.hotpathSnapshot());
      }
      // B5: same trust level and the same content-free guarantee as the route
      // above. GET, so it also passes the CSRF guard untouched - it changes
      // nothing beyond writing (and deleting) a probe byte in Flow's own folder.
      if (req.method === "GET" && url.pathname === "/diagnostics/selfcheck") {
        return json(200, await this.deps.selfCheck());
      }
      if (req.method === "GET" && url.pathname === "/update-readiness") {
        // The quiet window: never swap binaries while a dictation, a long
        // recording OR a model download is in flight (review A10: killing a
        // 1 GB ensureModel mid-transfer wastes the whole download).
        const ready =
          !this.deps.isListening() && !this.deps.isRecording() && !(this.deps.isUpdateBusy?.() ?? false);
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
        // v6 c7: dir is OPTIONAL now. Absent/empty -> the engine records into an
        // app-owned staging folder and the destination is chosen at Stop.
        const body = await readJson(req);
        return json(200, this.deps.longStart({
          dir: typeof body?.dir === "string" ? body.dir : undefined,
          title: typeof body?.title === "string" ? body.title : undefined,
          keepAudio: body?.keepAudio === true,
        }));
      }
      if (req.method === "POST" && url.pathname === "/long/start-native") {
        // C2: engine-side native capture (loopback + mic, no picker). Windows only;
        // index.ts returns { ok:false } elsewhere.
        const body = await readJson(req);
        return json(200, this.deps.longStartNative({
          title: typeof body?.title === "string" ? body.title : undefined,
          keepAudio: body?.keepAudio === true,
          captureSystem: body?.captureSystem === true,
        }));
      }
      if (req.method === "POST" && url.pathname === "/long/save") {
        // v6 c7: move the finished recording out of staging into the user's
        // folder. May block briefly if finalize is still running (engine waits).
        const body = await readJson(req);
        const dir = typeof body?.dir === "string" ? body.dir : "";
        if (!dir) return json(400, { ok: false, error: "missing dir" });
        return json(200, await this.deps.longSave(dir));
      }
      if (req.method === "POST" && url.pathname === "/long/notes-splice") {
        const body = await readJson(req);
        const docPath = typeof body?.docPath === "string" ? body.docPath : "";
        const notes = typeof body?.notes === "string" ? body.notes : "";
        return json(200, this.deps.longNotesSplice(docPath, notes));
      }
      if (req.method === "GET" && url.pathname === "/long/transcript") {
        const since = Number(url.searchParams.get("since") || "0") || 0;
        return json(200, this.deps.longTranscript(since));
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
      // ---- Archive 2026-07-14: recording history browser ----
      if (req.method === "GET" && url.pathname === "/long/history") {
        return json(200, { items: this.deps.listHistory() });
      }
      if (req.method === "GET" && url.pathname === "/long/history/doc") {
        const id = url.searchParams.get("id") || "";
        const payload = this.deps.readHistoryDoc(id);
        if (!payload) return json(404, { error: "not found" });
        return json(200, payload);
      }
      if (req.method === "GET" && url.pathname === "/long/history/audio") {
        const id = url.searchParams.get("id") || "";
        const entry = this.deps.resolveHistoryEntry(id);
        if (!entry || !entry.audio) return json(404, { error: "not found" });
        // Raw bytes, not the json() helper: this response is streamed straight
        // through writeHead/pipe below, then we return before falling into the
        // JSON branches.
        this.streamAudioFile(entry.audio, req, res);
        return;
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
        const out = await this.deps.transcribe(wav);
        return json(200, out);
      }
      json(404, { error: "not found" });
    } catch (err) {
      json(500, { error: String(err) });
    }
  }

  /** Archive 2026-07-14: stream a history .wav in raw bytes, honoring a Range
   * header so the phone's <audio> element can seek. Always a pipe from disk,
   * never a full read into RAM - a multi-hour capture must not balloon the
   * engine's memory just because someone opens the archive. */
  private streamAudioFile(file: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      const body = JSON.stringify({ error: "not found" });
      res.writeHead(404, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const total = stat.size;
    const range = req.headers.range;
    const m = typeof range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": end - start + 1,
      });
      const stream = fs.createReadStream(file, { start, end });
      stream.on("error", () => res.end());
      stream.pipe(res);
      return;
    }
    // Fallback: a plain 200 full-body response is acceptable per spec when
    // there is no (valid) Range header.
    res.writeHead(200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": total });
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.end());
    stream.pipe(res);
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
