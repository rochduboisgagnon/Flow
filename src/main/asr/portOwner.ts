import { execFile } from "node:child_process";
import { childEnv } from "../../shared/childEnv";

// ---------------------------------------------------------------------------
// Security scan F4 + F5 (both MEDIUM, both 3/3, 2026-08-02). Who is actually
// answering on the speech engine's port.
//
// F5 is the race: findFreePort binds a candidate, closes it, and hands the
// NUMBER to whisper-server on its command line. Nobody owns that port for the
// whole spawn-plus-model-load window - tens of seconds for a large model. F4 is
// the consequence: waitReady declared the engine ready because SOMETHING on
// 127.0.0.1:<port> answered HTTP, and inferOnce then posted every utterance to
// it and trusted the text that came back. A local process that wins the race
// receives the raw WAV of every dictation plus the user's dictionary terms, and
// decides the exact string Flow types at the cursor - as synthetic keystrokes,
// when insertMode is "type".
//
// The fix is one check rather than two, and that is the point: verify that the
// socket answering us BELONGS to the child we spawned. With that in place the
// pre-probed port stops mattering, because winning the race no longer wins
// anything - the squatter is simply not our PID.
//
// WHY NOT A SHARED SECRET, which the scan suggested first: whisper-server is a
// third-party binary. It has no flag for "require this header", so a token
// would have to be enforced by a component we do not control. Process ownership
// is enforced by the operating system, which is a better place for it.
//
// THREE-VALUED ON PURPOSE. `false` means the OS named a different owner - that
// is an answer, and it stops everything. `null` means we could not find out
// (PowerShell missing, cmdlet unavailable, a locked-down host). A security check
// that cannot run must not silently pass, and must not brick dictation either;
// the caller logs it and continues, which is stated plainly at the call site
// rather than hidden here.
// ---------------------------------------------------------------------------

// WHY netstat AND NOT PowerShell, which is what this used first.
//
// Adverse review, measured on this machine rather than assumed: the PowerShell
// form (`Get-NetTCPConnection`) took 1347 ms. netstat.exe takes 55 ms for the
// same answer - twenty-four times faster. That difference is the whole design,
// because this sits on the path to a warm engine and a lazy start or a watchdog
// respawn makes the next dictation wait for it. A second and a half is not a
// detail on a product whose promise is "the text the instant you let go".
//
// It also fixed a subtler failure the review named: with a four-second budget
// and a 1.3 s baseline, a cold PowerShell behind an antivirus would routinely
// blow the timeout, land in "could not tell", and so cost a second and a half
// while verifying NOTHING - the worst of both. At 55 ms that stops being a
// realistic outcome.
//
// The parse deliberately does NOT read the State column: netstat is localized
// (French Windows prints "À L'ÉCOUTE"), and a check that only works in English
// is a check that silently stops working on somebody else's machine. The local
// address and the `0.0.0.0:0` peer of a listening socket are not translated.

/** Milliseconds before we give up asking the OS. "I could not tell" is a usable
 * answer, so this is short on purpose. */
const OWNER_TIMEOUT_MS = 3_000;

export interface PortOwnerDeps {
  /** Test seam. Resolves with the raw stdout of the ownership query. */
  run?(cmd: string, args: string[]): Promise<string>;
  platform?: string;
  log?(msg: string): void;
}

function defaultRun(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: OWNER_TIMEOUT_MS, windowsHide: true, env: childEnv() },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

/**
 * The PID listening on `127.0.0.1:port`, from `netstat -ano -p TCP` output.
 *
 * Deliberately strict: any shape we do not recognise is "unknown", never
 * "fine". A parser that guesses turns a security check into a coin toss.
 *
 * Matched on the two columns that are NOT localized - the exact local address,
 * and the `0.0.0.0:0` peer that only a listening socket has. Reading the State
 * word would have made this work in English and quietly stop working in French.
 */
export function parseOwningPid(stdout: string, port: number): number | null {
  const local = `127.0.0.1:${port}`;
  for (const line of String(stdout).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Proto, Local, Foreign, State, PID
    if (cols.length < 5) continue;
    if (cols[1] !== local) continue;
    if (cols[2] !== "0.0.0.0:0") continue; // not a listener: an outbound connection
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * Does `pid` own the socket listening on `port`?
 *
 * `true` yes, `false` someone else does, `null` could not be determined.
 */
export async function socketOwnedBy(
  port: number,
  pid: number | undefined,
  deps: PortOwnerDeps = {},
): Promise<boolean | null> {
  if (!pid || !port) return null;
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return null; // Flow ships on Windows; elsewhere we cannot tell
  const run = deps.run ?? defaultRun;
  try {
    const out = await run("netstat.exe", ["-ano", "-p", "TCP"]);
    const owner = parseOwningPid(out, port);
    if (owner === null) return null;
    return owner === pid;
  } catch (err) {
    deps.log?.(`[whisper-server] could not determine port ownership: ${(err as Error).message}`);
    return null;
  }
}
