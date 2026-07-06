import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { parseFocusLine, type FocusResult } from "../../shared/route";

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
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
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

  /** One focus query. Returns null (=> route to clipboard) on any failure. */
  async probe(): Promise<FocusResult | null> {
    try {
      await this.ensureStarted();
    } catch {
      return null; // probe unavailable -> HOLD
    }
    const proc = this.proc;
    if (!proc || !proc.stdin) return null;
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

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.rl = null;
    this.ready = null;
  }
}
