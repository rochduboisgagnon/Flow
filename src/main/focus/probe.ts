import { childEnv } from "../../shared/childEnv";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { parseFocusLine, type FocusResult } from "../../shared/route";
import { silentFailures, SILENT_FAILURE } from "../../shared/silentFailures";

// FocusProbe: a persistent PowerShell process that answers "is the focused UI
// element editable?" over stdin/stdout, spawned once and queried per dictation.
//
// Why PowerShell and not a compiled exe: the managed UI Automation client loads
// cleanly from the GAC here, whereas a fresh csc-built exe both hit a native
// UIAutomationCore.dll resolution failure AND got quarantined by Defender as an
// unsigned binary. This uses only what ships with Windows - no build step, no
// toolchain, in the spirit of "no node-gyp".
//
// The probe reads the SYSTEM focused element, so it must run on the interactive
// desktop (it does, inside the running app). When in any doubt it returns
// editable:false, so the app HOLDs to the clipboard instead of typing blindly.

const PROBE_TIMEOUT_MS = 1500;

export class FocusProbe {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private ready: Promise<void> | null = null;
  private queue: Array<(line: string | null) => void> = [];
  private scriptPath: string;
  private log?: (msg: string) => void;
  /** B6: the "probe unavailable" line is written once per process, not once per
   * dictation - see noteUnavailable(). */
  private reportedUnavailable = false;

  constructor(scriptPath: string, log?: (msg: string) => void) {
    this.scriptPath = scriptPath;
    this.log = log;
  }

  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // 2026-07-31: a PowerShell child inheriting the full environment is the
          // worst of the two spawn sites - it is a general-purpose interpreter.
          env: childEnv(),
        },
      );
      this.proc = proc;
      const rl = readline.createInterface({ input: proc.stdout! });
      this.rl = rl;
      let started = false;
      rl.on("line", (line) => {
        if (!started) {
          // First line is the readiness handshake ({"ready":true}).
          started = true;
          resolve();
          return;
        }
        const waiter = this.queue.shift();
        if (waiter) waiter(line);
      });
      proc.on("exit", () => {
        this.proc = null;
        this.rl = null;
        this.ready = null;
        // Fail any in-flight probes so callers fall back to HOLD, never hang.
        while (this.queue.length) this.queue.shift()?.(null);
      });
      proc.stderr?.on("data", (d: Buffer) =>
        this.log?.(`[focus-probe] ${String(d).trim().slice(0, 200)}`),
      );
      proc.on("error", (e) => {
        if (!started) reject(e);
      });
    });
    return this.ready;
  }

  /**
   * B2: pay ensureStarted() at STARTUP instead of inside the first dictation.
   *
   * Measured, not guessed: spawning powershell.exe and waiting for its
   * readiness handshake costs ~400 ms on this machine (B1 measured 457 ms and
   * 535 ms inside the live app, on two separate starts). Because ensureStarted()
   * is lazy, that whole cost used to land on the FIRST press of every session -
   * squarely between "the user released the key" and "the text appears", the
   * one interval §3.3 budgets at 60 ms. Every later press paid ~12 ms. So the
   * worst number on the whole bench belonged to a process that could have been
   * started while the user was still logging in.
   *
   * It then throws ONE query away, and that second half is not decoration:
   * measured, spawning the process alone brings the first dictation's probe
   * from ~400 ms down to ~120 ms, because PowerShell's UI Automation client
   * does its own lazy loading on the first actual query - the readiness
   * handshake resolves before any of it. Paying that query here too takes the
   * first press to the ~12 ms every later press already cost. The answer is
   * discarded: it describes whatever happened to be focused at startup, which
   * is nobody's business and no use to anyone.
   *
   * Fire-and-forget by design, exactly like warmAsr(): a probe that fails to
   * warm is not an error anybody needs to see here. probe() re-tries on its own
   * and falls back to HOLD (clipboard) when it cannot, which is the behaviour
   * that existed before this method and is unchanged by it.
   */
  async warm(): Promise<void> {
    try {
      await this.ensureStarted();
      await this.probe();
    } catch {
      /* the first real probe() retries, reports, and falls back to HOLD */
    }
  }

  /** One focus query. Returns null (=> route to clipboard) on any failure. */
  async probe(): Promise<FocusResult | null> {
    try {
      await this.ensureStarted();
    } catch (err) {
      // B6: was completely silent, and it is the failure with the widest reach
      // in the whole hot path - a probe that cannot start makes EVERY dictation
      // of the session land on the clipboard instead of at the cursor, and
      // nothing anywhere said why. Counted every time (Diagnostics), logged
      // ONCE: the cause is the same PowerShell that failed to spawn, and a line
      // per dictation would bury the log without adding a fact.
      this.noteUnavailable(err);
      return null; // probe unavailable -> HOLD
    }
    const proc = this.proc;
    if (!proc || !proc.stdin) {
      // The same fact one moment later: the probe process died between the
      // handshake and this query. Same counter, same reason.
      this.noteUnavailable(new Error("the focus probe process is gone"));
      return null;
    }
    return new Promise<FocusResult | null>((resolve) => {
      let settled = false;
      const done = (line: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(line === null ? null : parseFocusLine(line));
      };
      const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
      this.queue.push(done);
      proc.stdin!.write("probe\n");
    });
  }

  /** B6: count always, log the first one only (see probe()). */
  private noteUnavailable(err: unknown): void {
    silentFailures.increment(SILENT_FAILURE.focusProbeUnavailable);
    if (this.reportedUnavailable) return;
    this.reportedUnavailable = true;
    this.log?.(
      `[focus-probe] unavailable (${String(err)}); every dictation will land on the clipboard ` +
        "instead of at the cursor until it recovers. Further occurrences are counted, not logged.",
    );
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.rl = null;
    this.ready = null;
  }
}
