import http from "node:http";
import fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { dataDir } from "./settings";
import type { RecordingSummary, RecordingDocPayload } from "../shared/recordings";

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
  // B3e : le navigateur d'archive lit le COMPTE. `listHistory` et
  // `readHistoryDoc` sont les MEMES fonctions que les canaux UI_HISTORY_*
  // utilisent - jamais une seconde copie de la lecture et de son plafond.
  //
  // `resolveHistoryEntry` a disparu avec le dossier qu'il resolvait, et la route
  // audio a change de nature avec lui : elle ne diffuse plus un fichier local,
  // elle REDIRIGE vers une URL signee. Le changement est un gain - le seau est
  // prive, l'URL expire, et les octets ne traversent plus le processus qui porte
  // le crochet clavier pour aller d'un disque a un telephone.
  listHistory(): Promise<RecordingSummary[]>;
  readHistoryDoc(id: string): Promise<RecordingDocPayload | null>;
  signAudio(id: string): Promise<{ url: string; bytes: number } | null>;
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

/** F5: can we bind this port right now?
 *
 * The question behind it is "is the engine that wrote this discovery file still
 * alive", and a PID cannot answer it: pidAlive() says true on EPERM, so any
 * process of another account that inherited that number reads as "the previous
 * engine". Windows recycles PIDs aggressively.
 *
 * A free port answers it honestly. We only try to BIND - never to talk to
 * whoever might be there, which would be sending a request to a stranger. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
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

  /**
   * 2026-07-31, security pass. A per-session token that Flow's OWN window
   * carries, and nothing else has.
   *
   * The problem it solves: the drive-by guard below refused browser requests on
   * state-changing methods only, so GET was open - and GET is what returns
   * `/long/history/doc` and `/long/history/audio`, i.e. meeting transcripts and
   * their audio. What kept a hostile page from READING those answers was the
   * browser's own same-origin policy (this API sends no CORS header), never
   * anything this file did. A defence living entirely in the attacker's runtime
   * is not a defence.
   *
   * Extending the guard to GET was the obvious move and it would have broken
   * the app: the Notes page plays audio through an <audio> element pointing
   * here, which IS a browser request and does carry Sec-Fetch-* headers. That is
   * the U3 mistake exactly - a security control scoped one notch too wide,
   * killing a feature no test covers.
   *
   * So: browser-originated requests must present this token. Flow's window gets
   * it in the state payload, beside the port it already receives. The sibling
   * apps (Pilot server, Manager) call server-to-server, send no browser headers,
   * and are unaffected - which is why the token is required only when those
   * headers are present.
   *
   * ---------------------------------------------------------------------------
   * 2026-08-02, security scan F2 (MEDIUM, 3/3): the paragraph above was wrong,
   * and it was wrong in the way that matters - it made a control sound like a
   * boundary when it was a courtesy.
   *
   * "Required only when those headers are present" means required only of
   * callers who VOLUNTEER that they are browsers. A local process omits Origin
   * and Sec-Fetch-Site, is judged not-a-browser, and is never asked for
   * anything. It then reads every meeting transcript, downloads every .wav,
   * follows a meeting being recorded right now, starts a mic + system capture
   * under the OS consent granted to Flow, rewrites settings and quits the
   * engine. The Host allowlist below does not help: Host is a header the caller
   * writes itself.
   *
   * The token is now required on EVERY request, unconditionally. What the
   * conditional bought - sibling apps working without changes - is bought
   * instead by publishing the token in the discovery file those apps already
   * read for the port. See start() for why that file is the right place and for
   * the exact boundary it does and does not draw.
   * ---------------------------------------------------------------------------
   */
  private token = randomBytes(32).toString("base64url");

  /** The bound loopback port (0 until start() succeeds). Shown in Diagnostics. */
  boundPort(): number {
    return this.port;
  }

  /** Handed to Flow's own renderer through the state payload. Never logged. */
  sessionToken(): string {
    return this.token;
  }

  /** Constant-time compare, so the token cannot be recovered a byte at a time.
   * Cheap insurance: the threat is far-fetched over loopback, and getting it
   * right costs one function. */
  private tokenOk(given: string | null): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
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
      const raw = JSON.parse(fs.readFileSync(info, "utf8")) as { pid?: number; port?: number };
      // F5 (second scan) : `pidAlive` seul ne suffit pas. Il repond VRAI sur
      // EPERM, donc sur n'importe quel processus d'un autre compte ayant
      // recupere ce numero - et Windows recycle les PID agressivement. Un
      // fichier de decouverte perime designant un PID reattribue privait donc
      // silencieusement la session de son jeton : les applications soeurs
      // restaient dehors, sans un message, jusqu'au prochain demarrage.
      //
      // Le port est ce qui tranche : si le fichier annonce un port et que
      // PERSONNE n'ecoute dessus, l'ancien moteur est mort quoi qu'en dise le
      // PID, et le fichier est a nous. On ne parle pas au port (ce serait une
      // requete a un inconnu) : on essaie seulement de le lier.
      const stale = typeof raw.port === "number" && raw.port > 0 && (await portFree(raw.port));
      if (!stale && typeof raw.pid === "number" && raw.pid !== process.pid && pidAlive(raw.pid)) {
        // F2 note (adverse review): this early return now also means "this
        // session's token is never published", so sibling apps cannot reach US.
        // That is the correct outcome rather than a new hole: the port and the
        // token travel in the same file, so a sibling reaches whichever engine
        // OWNS that file, holding that engine's token. The pair stays coherent.
        // What remains wrong here is older than F2 - pidAlive() answers true on
        // EPERM, so a recycled PID belonging to another account reads as "the
        // previous engine is alive" and we quietly run without discovery.
        this.deps.log?.(`[api] not overwriting ${info}: it advertises live pid ${raw.pid} (the previous engine)`);
        return;
      }
    } catch {
      /* absent or unreadable: ours to write */
    }
    // F2: the discovery file now carries the session token as well as the port.
    //
    // This is what lets the token be mandatory without breaking the sibling apps
    // (the Pilot server drives the whole /long/* recording flow from the phone).
    // They already read this file to find the port; they now read one more field
    // and send it back. A token they can fetch is not a secret from them - it is
    // not meant to be. It is meant to be a secret from everyone who cannot read
    // this file.
    //
    // WHICH IS EXACTLY THE BOUNDARY THIS DRAWS, and it is worth being precise
    // rather than reassuring:
    //
    //  - Another LOCAL USER ACCOUNT cannot read it. The file lives under the
    //    user's profile, which Windows ACLs already close to other non-admin
    //    accounts. That is the attacker F2 describes, and this closes them out.
    //  - A process running AS THIS USER can read it, and no file permission can
    //    change that. It is also not a meaningful loss: that process can already
    //    read history.json and the recordings folder directly. The API stops
    //    being a shortcut, which is all a token was ever going to achieve.
    //
    // The mode is set for POSIX (tests and any future port). On Windows it only
    // touches the read-only bit and the profile ACL above is the real control -
    // saying so beats implying a guarantee this line does not give.
    const payload = JSON.stringify({
      app: "agr-flow",
      port: this.port,
      pid: process.pid,
      version: this.deps.version,
      token: this.token,
    });
    fs.writeFileSync(info, payload, { mode: 0o600 });
    try {
      fs.chmodSync(info, 0o600); // writeFileSync only applies mode when CREATING
    } catch {
      /* best effort: a pre-existing file we cannot chmod is still ACL-protected */
    }
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
    // F7 (second scan) : `new URL` LEVE sur une cible malformee, et cette ligne
    // etait au-dessus de tout - au-dessus du controle d'hote, au-dessus du
    // jeton, au-dessus du try. Comme route() est appelee en `void this.route(...)`,
    // le rejet n'avait personne pour l'attraper : rejet de promesse non gere,
    // et surtout une requete qui reste ouverte sans reponse jusqu'a son propre
    // delai. Un plantage du processus principal, c'est le hook clavier qui tombe.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "malformed request target" }));
      return;
    }
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
    //
    // 2026-07-31: extended to GET, which was open and is what serves transcripts
    // and audio. A browser request is now allowed ONLY if it carries this
    // session's token - which Flow's own window has and a drive-by page cannot
    // obtain. See sessionToken() above for why the token, rather than simply
    // widening the header check, was necessary.
    //
    // ---------------------------------------------------------------------
    // 2026-08-02, security scan (HIGH): the token check BELOW was bypassable,
    // and this Host check is what actually closes it.
    //
    // The bypass is DNS rebinding, and it works because the check below asks
    // the request whether it is browser-issued - a question the attacker
    // answers by OMISSION. Per Fetch Metadata, `Sec-Fetch-*` is only appended
    // for a "potentially trustworthy" URL. `http://127.0.0.1:8176` qualifies;
    // `http://attacker.tld:8176` does not, EVEN WHEN IT RESOLVES TO 127.0.0.1.
    // So a page served from a rebound hostname, reloaded on this port, becomes
    // same-origin with this API, sends neither Origin (same-origin GET) nor
    // Sec-Fetch-Site, is judged "not a browser", is never asked for a token -
    // and same-origin policy then lets it READ every response: the meeting
    // list, every transcript, every .wav, and the live transcript of a meeting
    // being recorded right now.
    //
    // The Host header is what the two cases cannot share. A real local client
    // sends `Host: 127.0.0.1:<port>`; a rebound page sends the attacker's own
    // hostname, because that is the name it asked for. Checking it defeats
    // rebinding regardless of which headers a browser decides to attach - which
    // is the property the check below lacked.
    // ---------------------------------------------------------------------
    const host = String(req.headers["host"] ?? "");
    const hostOk = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
    if (!hostOk) {
      return json(403, { error: "refused: this API answers only to 127.0.0.1" });
    }

    // F2 (2026-08-02): the token is required of EVERY caller, with no exception
    // and no sniffing of what kind of caller this is. The previous version asked
    // only requests that carried Origin or Sec-Fetch-Site - which is to say, only
    // callers honest enough to admit being browsers. Omitting both headers was a
    // complete bypass, and omitting a header costs an attacker nothing.
    //
    // Two accepted forms, and both are needed:
    //  - `X-Flow-Token`, for anything that can set a header (the sibling apps).
    //  - `?t=`, for the ONE caller that cannot: the <audio> element on the Notes
    //    page, whose src is a URL and nothing else. Dropping the query form to
    //    look stricter would silently kill playback - the U3 mistake, again.
    const given = url.searchParams.get("t") ?? (req.headers["x-flow-token"] as string | undefined) ?? null;
    if (!this.tokenOk(given)) {
      return json(403, {
        error: "refused: this API requires the session token from Flow's discovery file",
      });
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
        // 2026-08-02, security scan (MEDIUM): `dir` used to be passed through to
        // the recorder, which only checked that the path existed before writing
        // a .md and a .wav into it. A local process running as a DIFFERENT user
        // could therefore make Flow - running as this user - create files
        // wherever this user can write, the Startup folder included, using
        // privileges the caller does not have.
        //
        // Refused outright rather than sanitized, because nothing legitimately
        // sends it: the Record page never passes a dir (it records into the
        // app-owned staging folder and the destination is chosen at Stop), and
        // neither sibling app calls this route. A parameter with no caller is
        // not a feature to protect, it is a hole to close.
        if (typeof body?.dir === "string" && body.dir.length > 0) {
          return json(400, {
            ok: false,
            error: "dir is not accepted here: recordings are staged in Flow's own folder",
          });
        }
        return json(200, this.deps.longStart({
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
        return json(200, { items: await this.deps.listHistory() });
      }
      if (req.method === "GET" && url.pathname === "/long/history/doc") {
        const id = url.searchParams.get("id") || "";
        const payload = await this.deps.readHistoryDoc(id);
        if (!payload) return json(404, { error: "not found" });
        return json(200, payload);
      }
      if (req.method === "GET" && url.pathname === "/long/history/audio") {
        const id = url.searchParams.get("id") || "";
        const signed = await this.deps.signAudio(id);
        if (!signed) return json(404, { error: "not found" });
        // UNE REDIRECTION, plus un flux d'octets.
        //
        // Ce que ca retire est exactement ce que la vieille version de cette
        // route payait : chaque saut dans le lecteur audio emettait une requete
        // Range, et chaque requete Range faisait relire un fichier de 115 Mo par
        // le processus PRINCIPAL - celui qui porte le crochet clavier et decide
        // si une dictee part. Storage sert maintenant les octets lui-meme, avec
        // ses propres requetes Range, et Flow ne fait que dire ou.
        //
        // L'URL est SIGNEE et courte : le seau reste prive, et une adresse
        // recopiee dans un message ne survit pas a la conversation.
        res.writeHead(302, { location: signed.url, "cache-control": "no-store" });
        res.end();
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
  // B3e : `streamAudioFile` est parti avec les fichiers qu'il diffusait. Il
  // portait une implementation de Range HTTP - parse de l'en-tete, 206 partiel,
  // 416 sur une plage impossible - qui existait pour qu'un lecteur audio puisse
  // sauter dans une reunion de trois heures. Storage sait faire tout ca, et il le
  // fait SANS passer par le processus qui porte le crochet clavier.


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
