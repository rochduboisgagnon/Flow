import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "../../shared/childEnv";

// ---------------------------------------------------------------------------
// P2 (vague P, 2026-08-02). Running a command-line tool as a model provider,
// once, correctly, on Windows.
//
// Everything here is a trap somebody has already paid for - most of them in AGR
// Pilot, in production, on this same machine. The point of this file is that
// Flow copies the DISCIPLINE and not the file (invariant 1: Flow depends on
// nothing, not even on Pilot's code).
//
// THE FIVE, in the order they will hurt:
//
// 1. THE PROMPT GOES ON STANDARD INPUT, NEVER ON THE COMMAND LINE. cmd.exe caps
//    a command line at about 8191 characters. A meeting-summary prompt passes
//    that easily. This is the most likely defect of the whole wave and it would
//    ONLY fail on long meetings - so never in a test written quickly.
//
// 2. A `.cmd` CANNOT BE SPAWNED DIRECTLY (EINVAL since Node 18.20). It goes
//    through `cmd.exe /d /s /c`, with every argument quoted by hand.
//
// 3. INSIDE THAT LINE, `%` MUST BE DOUBLED. cmd.exe substitutes `%VAR%` in what
//    it is handed, and what we hand it contains TRANSCRIPT - which contains
//    percent signs and quotes, because people say things.
//
// 4. KILLING A CLI MEANS KILLING A TREE. `child.kill()` does not reach
//    grandchildren on Windows (lesson RC-090, lived in production): without
//    `taskkill /PID <pid> /T /F` an abandoned assistance round leaves a live
//    `claude` still consuming.
//
// 5. NO PROCESS IS EVER KEPT WARM. Pilot keeps one alive per session for typing
//    latency; Flow must not. A resident `claude` on the machine that carries the
//    keyboard hook is memory, a handle on a session, and one more thing that can
//    wedge. One call, one process, which dies. The cost is two to five seconds,
//    and all three call sites already tolerate twenty-five to three hundred.
// ---------------------------------------------------------------------------

/** Where a CLI installed for the user, rather than system-wide, actually lands.
 *
 * Not decoration: `claude` installs per-user, and an Electron app launched from
 * a shortcut does NOT inherit the shell PATH that a terminal would have. Pilot
 * hit exactly this. */
export function enrichedPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const extra = [
    path.join(home, ".local", "bin"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Microsoft", "WindowsApps"),
    path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs"),
  ];
  const current = env.PATH || env.Path || "";
  return [current, ...extra].filter(Boolean).join(path.delimiter);
}

/**
 * Resolve a command NAME to a path, WITHOUT running it.
 *
 * This is the whole detection strategy, and the reason is measured rather than
 * aesthetic: `claude --version` costs one to two seconds of Node runtime
 * startup. Nothing in Flow can pay that at launch, and liveAssist re-probes
 * every 30 seconds while its panel is open - which would be a spawned process
 * every 30 seconds for the length of a meeting.
 *
 * Returns null when nothing resolves. Never throws: a failed lookup is an
 * answer, not an incident.
 */
export function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string | null {
  if (!name || name.includes("/") || name.includes("\\")) return null; // a path is not a name
  const dirs = enrichedPath(env).split(path.delimiter).filter(Boolean);
  // The order matters: a `.cmd` shim is what npm installs on Windows, and it is
  // usually what exists. Trying `.exe` first would find nothing most of the time.
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}

/**
 * Quote one argument for a `cmd.exe /c` command line.
 *
 * Two escapes, and the second is the one people forget: internal quotes are
 * DOUBLED, and every `%` is doubled too. Without the second, cmd.exe happily
 * substitutes `%USERNAME%` inside a meeting transcript, and the model receives
 * text nobody said.
 */
export function cmdQuoteArg(arg: string): string {
  return '"' + String(arg).replace(/"/g, '""').replace(/%/g, "%%") + '"';
}

export interface CliRunResult {
  /** What the tool wrote to stdout, trimmed. "" when it wrote nothing. */
  stdout: string;
  /** Trimmed, and capped: this reaches logs, and a CLI can be chatty. */
  stderr: string;
  code: number | null;
  /** True when we killed it: a timeout, or the caller's signal. */
  killed: boolean;
}

export interface CliRunOptions {
  bin: string;
  args: string[];
  /** The prompt. Goes on stdin. Never on the command line - see the header. */
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** A dedicated empty folder. NEVER the app's cwd and never a project folder:
   * a CLI that indexes its working directory would read whatever is there. */
  cwd: string;
  log?(msg: string): void;
  /** Test seam for the tree-kill, which cannot run in a unit test. */
  killTree?(pid: number): void;
}

const STDERR_CAP = 2_000;

/** Kill the whole tree. See trap 4 in the header. */
function killTree(pid: number): void {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } catch {
    /* best effort: the process may already be gone */
  }
}

/**
 * Run a CLI once and read its answer.
 *
 * Never throws for a tool-side failure: a non-zero exit, a timeout and an abort
 * all come back as a result the caller reads. The provider above turns them
 * into `null`, which is the contract every call site already handles.
 */
export function runCli(opts: CliRunOptions): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const isCmd = /\.(cmd|bat)$/i.test(opts.bin);
    // Trap 2 + 3: a .cmd goes through cmd.exe, and then every argument on that
    // line is ours to quote.
    const [file, argv] = isCmd
      ? ([
          process.env.COMSPEC || "cmd.exe",
          ["/d", "/s", "/c", [opts.bin, ...opts.args].map(cmdQuoteArg).join(" ")],
        ] as [string, string[]])
      : ([opts.bin, opts.args] as [string, string[]]);

    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: childEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let done = false;
    let killed = false;
    const kill = opts.killTree ?? killTree;

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout: out.trim(), stderr: err.trim().slice(0, STDERR_CAP), code, killed });
    };

    const stop = (why: string) => {
      if (done) return;
      killed = true;
      opts.log?.(`[llm-cli] ${why}`);
      if (child.pid) kill(child.pid);
      // Do NOT resolve here: let the exit event carry whatever the tool managed
      // to write. If the process never exits, the timer below already fired and
      // a second one would double-resolve, which `done` prevents.
      setTimeout(() => finish(null), 1_500);
    };

    const timer = setTimeout(() => stop(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs);
    const onAbort = () => stop("abandoned by the caller");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (c: Buffer) => (out += c));
    child.stderr?.on("data", (c: Buffer) => (err += c));
    child.on("error", (e) => {
      err += String(e.message);
      finish(null);
    });
    child.on("exit", (code) => finish(code));

    // Trap 1: the prompt, on stdin, and the pipe closed so the tool knows the
    // input has ended. An EPIPE here means the child died first; it is not an
    // error worth surfacing, the exit code already says everything.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdin);
  });
}
