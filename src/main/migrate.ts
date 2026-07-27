import fsNode from "node:fs";
import httpNode from "node:http";
import os from "node:os";
import path from "node:path";

// A5 - Flow leaves the nest. Until 0.22.0 the app was installed and supervised
// by AGR Manager, and everything on disk carried the "AGR" prefix. 1.0.0 is a
// standalone product named Flow, so three things move:
//
//   ~/.agr-flow                    -> ~/.flow          settings, api.json, flow.log, history
//   %LOCALAPPDATA%/AGR-Flow        -> %LOCALAPPDATA%/Flow          the ASR model store (~1.6 GB)
//   %LOCALAPPDATA%/AGR Manager/AGR Flow                            the managed install: deleted
//
// This is the one piece of code in the app that can destroy user data, so the
// rules are deliberately blunt:
//
//  1. IT NEVER BLOCKS THE BOOT. Every step is wrapped; a step that fails is
//     logged and simply retried on the next start. Flow always comes up.
//  2. A move is ONE fs.renameSync (atomic inside a volume, instant even for
//     1.6 GB) or it did not happen at all. Nothing is ever copied file by file,
//     so there is no half-migrated state to reason about, and the OLD folder is
//     never deleted - the worst case is "the old layout is still in use".
//  3. If both layouts exist, the NEW one wins and the old folder is left
//     untouched. Merging two data folders is a judgement call an automatic
//     migration is not allowed to make.
//  4. It is idempotent: once nothing old is left on disk, runMigration() does
//     no work and writes no log line at all.
//  5. It is pure Node - fs/http/os/path are injectable, no Electron import - so
//     every branch (including the failure paths) is unit-testable against
//     temporary folders.

/** ~/<this> - the new data folder. */
export const DATA_DIR_NEW = ".flow";
/** ~/<this> - the folder every release up to 0.22.0 used. */
export const DATA_DIR_OLD = ".agr-flow";
/** %LOCALAPPDATA%/<this>/models - the new ASR model store. */
export const MODELS_ROOT_NEW = "Flow";
/** %LOCALAPPDATA%/<this>/models - the store up to 0.22.0. */
export const MODELS_ROOT_OLD = "AGR-Flow";
/** AGR Manager's own home under %LOCALAPPDATA%. */
export const MANAGER_DIR = "AGR Manager";
/** The app folder AGR Manager installs Flow into, and the exe that proves it. */
export const MANAGED_APP_DIR = "AGR Flow";
export const MANAGED_APP_EXE = "AGR Flow.exe";
/** Marker that tells AGR Manager's watchdog "the user removed Flow, do not
 * reinstall or relaunch it". Same convention as its own pilot-removed.txt. */
export const FLOW_REMOVED_MARKER = "flow-removed.txt";

/** The slice of node:fs this module uses. Narrow on purpose: the tests inject a
 * wrapper to force the failure paths (a rename that throws EBUSY, a folder that
 * cannot be removed) without having to reproduce them on a real disk. */
export interface MigrationFs {
  existsSync(p: string): boolean;
  renameSync(from: string, to: string): void;
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string): void;
  /** Recursive + force, i.e. a missing path is success, not an error. */
  rmSync(p: string): void;
}

/** Default backing: plain node:fs. Written as an adapter rather than passing
 * `fs` itself so the narrow interface above stays the contract. */
export const nodeFs: MigrationFs = {
  existsSync: (p) => fsNode.existsSync(p),
  renameSync: (from, to) => fsNode.renameSync(from, to),
  readFileSync: (p) => fsNode.readFileSync(p, "utf8"),
  writeFileSync: (p, data) => fsNode.writeFileSync(p, data),
  rmSync: (p) => fsNode.rmSync(p, { recursive: true, force: true }),
};

/** %LOCALAPPDATA%, with the same fallback the model store has always used. */
export function defaultLocalAppData(): string {
  return process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? os.homedir(), "AppData", "Local");
}

/** Flow's data folder for THIS run: the new name if it is already there, else
 * the old one (the migration has not run, or it failed and will be retried),
 * else the new one (fresh install). Never both - if the two exist side by side
 * the new layout is authoritative and runMigration() logs the leftover.
 *
 * Read-only by design (existsSync only): callers may invoke it at any time,
 * including from tests, without anything appearing on disk. */
export function resolveDataDir(home: string, io: MigrationFs = nodeFs): string {
  const next = path.join(home, DATA_DIR_NEW);
  if (safeExists(io, next)) return next;
  const old = path.join(home, DATA_DIR_OLD);
  if (safeExists(io, old)) return old;
  return next;
}

/** Same rule for the model store root (the folder that CONTAINS `models`).
 * Getting this wrong costs a 1.6 GB re-download, so it must resolve exactly
 * like resolveDataDir: new-if-present, else old-if-present, else new. */
export function resolveModelsRoot(localAppData: string, io: MigrationFs = nodeFs): string {
  const next = path.join(localAppData, MODELS_ROOT_NEW);
  if (safeExists(io, next)) return next;
  const old = path.join(localAppData, MODELS_ROOT_OLD);
  if (safeExists(io, old)) return old;
  return next;
}

export interface MigrationOptions {
  home?: string;
  localAppData?: string;
  io?: MigrationFs;
  /** Our own version string. An api.json advertising it is a PREVIOUS RUN OF
   * OURSELVES (or another instance), never the old app: we must not /quit it. */
  selfVersion?: string;
  /** Our own pid - same guard, one level stricter. */
  selfPid?: number;
  /** POST /quit to the loopback API of the previous engine. Resolves true when
   * the call was answered; false is not an error (it may simply not be up). */
  requestQuit?: (port: number) => Promise<boolean>;
  /** Is that pid still alive? (process.kill(pid, 0) by default.) */
  isAlive?: (pid: number) => boolean;
  /** Is this exe currently being executed by some process? (Windows locks a
   * running binary against writing; opening it "r+" fails EBUSY/EPERM.) This is
   * the api.json-independent proof of life the adversarial review demanded:
   * discovery files can be overwritten, stale or not yet written, but a locked
   * managed exe means the old engine (or its children) is unquestionably up. */
  isExeLocked?: (exePath: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How long we wait for the previous engine to disappear after /quit. */
  quitTimeoutMs?: number;
  /** Grace after its pid is gone: whisper-server is a CHILD process and holds
   * the model file open, so renaming the 1.6 GB store the same millisecond the
   * parent dies is exactly how you earn an EBUSY. */
  graceMs?: number;
}

export interface MigrationOutcome {
  /** Everything worth telling the user, in order. index.ts replays these into
   * flow.log once logging points at the resolved data folder. */
  logs: string[];
  /** The data folder to use for the rest of this process. */
  dataDir: string;
  /** The model store root to use for the rest of this process. */
  modelsRoot: string;
  dataMoved: boolean;
  modelsMoved: boolean;
  managedInstallRemoved: boolean;
}

const POLL_MS = 100;

/** Runs the whole 1.0.0 migration, best effort, in the documented order.
 * Never throws and never rejects: a migration problem must degrade to "keep
 * using the old layout", never to "Flow does not start". */
export async function runMigration(opts: MigrationOptions = {}): Promise<MigrationOutcome> {
  const io = opts.io ?? nodeFs;
  const home = opts.home ?? os.homedir();
  const local = opts.localAppData ?? defaultLocalAppData();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const requestQuit = opts.requestQuit ?? ((port: number) => defaultRequestQuit(port, 3000));
  const now = opts.now ?? (() => new Date());
  const quitTimeoutMs = opts.quitTimeoutMs ?? 5000;
  const graceMs = opts.graceMs ?? 500;

  const logs: string[] = [];
  const log = (m: string) => logs.push("[migrate] " + m);

  const oldData = path.join(home, DATA_DIR_OLD);
  const newData = path.join(home, DATA_DIR_NEW);
  const oldModels = path.join(local, MODELS_ROOT_OLD);
  const newModels = path.join(local, MODELS_ROOT_NEW);
  const managedDir = path.join(local, MANAGER_DIR, MANAGED_APP_DIR);
  const managedExe = path.join(managedDir, MANAGED_APP_EXE);

  // (a) Is the AGR-Manager-installed 0.22.0 still on disk?
  const managed = safeExists(io, managedExe);

  // Steady state (the overwhelmingly common case): nothing old anywhere, so
  // there is nothing to stop, move or delete. Return in silence - a migration
  // that logs on every boot would just train the user to ignore flow.log.
  const stale = safeExists(io, oldData) || safeExists(io, oldModels);
  if (!managed && !stale) {
    return {
      logs,
      dataDir: resolveDataDir(home, io),
      modelsRoot: resolveModelsRoot(local, io),
      dataMoved: false,
      modelsMoved: false,
      managedInstallRemoved: false,
    };
  }

  // (b) Neutralize AGR Manager's watchdog BEFORE killing anything. Without this
  // marker it notices Flow is gone and reinstalls/relaunches it within ~30 s,
  // which would resurrect the very process we are about to shut down.
  if (managed) {
    try {
      io.writeFileSync(path.join(local, MANAGER_DIR, FLOW_REMOVED_MARKER), now().toISOString() + "\n");
      log(`wrote ${FLOW_REMOVED_MARKER} so AGR Manager stops managing Flow`);
    } catch (err) {
      log(`could not write ${FLOW_REMOVED_MARKER} (${describe(err)}): AGR Manager may relaunch the old app`);
    }
  }

  // (c) Ask the previous engine to quit, properly (it owns a keyboard hook, a
  // whisper-server child and open files under the folders we are about to move).
  const isExeLocked = opts.isExeLocked ?? defaultIsExeLocked;
  let previousGone = await stopPreviousEngine(
    { io, log, sleep, isAlive, requestQuit, quitTimeoutMs, graceMs },
    // Whatever is running right now writes its api.json where resolveDataDir
    // points, so look there FIRST: a leftover api.json in the other folder can
    // be years old, and acting on a recycled pid/port would mean POSTing /quit
    // at a stranger. The other folders are only a fallback.
    [resolveDataDir(home, io), oldData, newData],
    opts.selfPid ?? process.pid,
    opts.selfVersion ?? "",
  );
  // Review A10 (critical): discovery files are NOT proof. Our own boot may have
  // overwritten the old engine's api.json on a previous deferred run, and a
  // 0.22.0 that is still starting has not written its own yet. The managed exe
  // being locked by a live process is evidence no file can fake: while it holds,
  // nothing gets moved and nothing gets deleted, whatever api.json claims.
  if (previousGone && managed && isExeLocked(managedExe)) {
    log("the managed exe is still locked by a running process: folders left as they are, will retry on the next start");
    previousGone = false;
  }

  // (d)+(e) The two moves. Skipped entirely while something is still holding the
  // folders: renaming a live app's data folder out from under it is the one way
  // this migration could actually lose work.
  let dataMoved = false;
  let modelsMoved = false;
  if (previousGone) {
    dataMoved = tryMove(io, log, oldData, newData, "data folder");
    modelsMoved = tryMove(io, log, oldModels, newModels, "model store");
  } else {
    log("the previous engine is still running: folders left as they are, will retry on the next start");
  }

  // (f) Retire the managed install. Only once we are confident nothing is
  // running out of it, and never fatal: a leftover folder is cosmetic (the
  // marker from (b) already stops AGR Manager from using it again).
  let managedInstallRemoved = false;
  if (managed && previousGone) {
    for (let attempt = 0; attempt < 2 && !managedInstallRemoved; attempt++) {
      if (attempt > 0) await sleep(500); // one retry: Windows releases exe locks lazily
      try {
        io.rmSync(managedDir);
        managedInstallRemoved = !safeExists(io, managedDir);
      } catch (err) {
        if (attempt > 0) log(`could not remove the managed install at ${managedDir} (${describe(err)})`);
      }
    }
    if (managedInstallRemoved) log(`removed the AGR Manager install at ${managedDir}`);
    else log(`the managed install at ${managedDir} is still there; it is no longer used`);
  }

  return {
    logs,
    dataDir: resolveDataDir(home, io),
    modelsRoot: resolveModelsRoot(local, io),
    dataMoved,
    modelsMoved,
    managedInstallRemoved,
  };
}

interface StopDeps {
  io: MigrationFs;
  log: (m: string) => void;
  sleep: (ms: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
  requestQuit: (port: number) => Promise<boolean>;
  quitTimeoutMs: number;
  graceMs: number;
}

/** Shuts down whatever engine owns the old data folder. Returns true when we
 * are confident nothing is holding those folders any more - including the case
 * "there was nothing running in the first place", which is the normal one. */
async function stopPreviousEngine(
  d: StopDeps,
  dataDirs: string[],
  selfPid: number,
  selfVersion: string,
): Promise<boolean> {
  // Review A10 (critical): a candidate whose api.json is OURS (our pid, or our
  // own version's leftover) must not end the search - the old engine's file may
  // sit in the NEXT folder of the list. "return true" here was exactly the hole
  // that let a half-migrated machine conclude "nothing runs" while 0.22.0 was
  // alive. Skip the file, keep looking; only an exhausted list means quiet.
  let info: ApiInfo | null = null;
  const seen = new Set<string>();
  for (const dir of dataDirs) {
    if (seen.has(dir)) continue; // resolveDataDir aliases one of the two others
    seen.add(dir);
    const candidate = readApiInfo(d.io, dir);
    if (!candidate) continue; // no discovery file in this folder
    if (candidate.pid === selfPid) continue; // our own api.json: not the old app
    if (selfVersion && candidate.version === selfVersion) {
      // Same version as us = a previous run of THIS build left a stale file, or
      // a sibling instance is up. Either way it is not the old app, and sending
      // it /quit would mean shutting Flow down at its own boot.
      d.log(`ignoring api.json from version ${candidate.version} in ${dir} (that is this build, not the old app)`);
      continue;
    }
    if (!d.isAlive(candidate.pid)) continue; // stale file from a process that is gone
    info = candidate;
    break;
  }
  if (!info) return true; // no LIVE foreign engine advertised anywhere

  d.log(`asking the previous engine to quit (pid ${info.pid}, port ${info.port}, version ${info.version || "?"})`);
  const answered = await d.requestQuit(info.port);
  if (!answered) d.log("POST /quit was not answered; waiting for the process anyway");

  let waited = 0;
  while (waited < d.quitTimeoutMs && d.isAlive(info.pid)) {
    await d.sleep(POLL_MS);
    waited += POLL_MS;
  }
  if (d.isAlive(info.pid)) {
    d.log(`the previous engine (pid ${info.pid}) is still alive after ${d.quitTimeoutMs} ms`);
    return false;
  }
  d.log(`the previous engine exited after ${waited} ms`);
  // Its whisper-server child can outlive it by a beat and holds the model file.
  if (d.graceMs > 0) await d.sleep(d.graceMs);
  return true;
}

interface ApiInfo {
  port: number;
  pid: number;
  version: string;
  app: string;
}

/** Reads <dir>/api.json (the loopback discovery file the engine writes at
 * startup). Anything unreadable, malformed or not written by a Flow build is
 * treated as absent: we only ever act on a file we fully understand. */
function readApiInfo(io: MigrationFs, dir: string): ApiInfo | null {
  try {
    const raw: unknown = JSON.parse(io.readFileSync(path.join(dir, "api.json")));
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const port = typeof r.port === "number" ? r.port : 0;
    const pid = typeof r.pid === "number" ? r.pid : 0;
    const appName = typeof r.app === "string" ? r.app : "";
    if (!port || !pid) return null;
    // "agr-flow" is what every build up to 0.22.0 writes; "flow" is the renamed
    // identity. Any other producer on this port is none of our business.
    if (appName !== "agr-flow" && appName !== "flow") return null;
    return { port, pid, version: typeof r.version === "string" ? r.version : "", app: appName };
  } catch {
    return null;
  }
}

/** One folder move. Returns true only when the rename actually happened. */
function tryMove(io: MigrationFs, log: (m: string) => void, from: string, to: string, label: string): boolean {
  if (!safeExists(io, from)) return false; // already migrated, or never existed
  if (safeExists(io, to)) {
    // Both layouts on disk. resolveDataDir/resolveModelsRoot already prefer the
    // new one; the old folder stays exactly where it is so nothing the user may
    // still want is thrown away by a machine decision.
    log(`${label}: ${from} and ${to} both exist - ${to} wins, the old folder is left untouched`);
    return false;
  }
  try {
    io.renameSync(from, to);
    log(`${label}: moved ${from} -> ${to}`);
    return true;
  } catch (err) {
    // EBUSY/EPERM: something still holds a file inside (the old app's flow.log,
    // a whisper-server mmap, an open Explorer window). Keep using the old path
    // and try again next boot - never fall back to a file-by-file copy.
    log(`${label}: could not move ${from} -> ${to} (${describe(err)}); still using ${from}, will retry on the next start`);
    return false;
  }
}

/** existsSync can itself throw (a path we may not stat). Treat that as absent:
 * the migration must not fail on a permission quirk. */
function safeExists(io: MigrationFs, p: string): boolean {
  try {
    return io.existsSync(p);
  } catch {
    return false;
  }
}

/** Windows refuses to open a running binary for writing (EBUSY/EPERM/ETXTBSY):
 * that refusal is our process-independent "the old engine is still up" signal.
 * A missing file or a clean open+close both mean "not locked". */
function defaultIsExeLocked(exePath: string): boolean {
  try {
    const fd = fsNode.openSync(exePath, "r+");
    fsNode.closeSync(fd);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EBUSY" || code === "EPERM" || code === "ETXTBSY";
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else - alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** POST /quit on the loopback API. Deliberately header-free: the engine's CSRF
 * guard refuses any state-changing request carrying Origin/Sec-Fetch-*. */
function defaultRequestQuit(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const req = httpNode.request(
      { host: "127.0.0.1", port, path: "/quit", method: "POST", timeout: timeoutMs },
      (res) => {
        res.resume(); // drain: an unread response keeps the socket open
        res.on("end", () => done((res.statusCode ?? 0) < 400));
        res.on("error", () => done(false));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false)); // nothing listening: it is not running
    req.end();
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
