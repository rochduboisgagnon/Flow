import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCliProvider, classifyClaudeError } from "../src/main/llm/claudeCli";
import type { CliRunResult } from "../src/main/llm/cliRunner";

// ---------------------------------------------------------------------------
// P3 (vague P). Claude Code as a notes provider.
//
// The behaviour of the real binary was verified by running it (claude.exe
// 2.1.220, 2026-08-02): a real transcript in, real meeting notes out, 12.6 s.
// These tests pin the things a future edit could silently break, and every one
// of them is a flag whose absence has a named consequence.
// ---------------------------------------------------------------------------

const OK = (stdout: string): CliRunResult => ({ stdout, stderr: "", code: 0, killed: false });

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-cli-"));
}

function spy() {
  const calls: Array<{ args: string[]; stdin: string; timeoutMs: number; cwd: string }> = [];
  const dir = tempCwd();
  const p = new ClaudeCliProvider({
    resolve: () => "C:/fake/claude.exe",
    cwd: () => dir,
    run: async (o) => {
      calls.push({ args: o.args, stdin: o.stdin, timeoutMs: o.timeoutMs, cwd: o.cwd });
      return OK("### Resume\n\nDes notes.");
    },
  });
  return { p, calls, dir };
}

test("P3: --strict-mcp-config is present, and its absence is the worst bug in the wave", async () => {
  const { p, calls } = spy();
  await p.long("le transcript");
  // Without it, a `claude` run from here loads every MCP server on the machine.
  // Someone in a meeting saying a sentence that reads like an order becomes a
  // prompt injection able to SEND EMAIL.
  assert.ok(calls[0].args.includes("--strict-mcp-config"));
});

test("P3: --no-session-persistence is present - the transcript must not land in a second place", async () => {
  const { p, calls } = spy();
  await p.long("le transcript");
  // Measured on the real CLI: without this flag, 18 KB of meeting transcript is
  // written in clear to ~/.claude/projects/<slug>/<uuid>.jsonl. With it, zero
  // files. Flow promises the interface never lies about where processing
  // happens; a copy the user does not know about breaks that promise.
  assert.ok(calls[0].args.includes("--no-session-persistence"));
});

test("P3: the built-in tools are switched off - Bash survives --strict-mcp-config", async () => {
  const { p, calls } = spy();
  await p.long("le transcript");
  const a = calls[0].args;
  assert.ok(a.includes("--disallowed-tools"));
  for (const t of ["Bash", "Read", "Write", "Edit", "WebFetch"]) {
    assert.ok(a.includes(t), `${t} must be denied: a summariser needs no tools at all`);
  }
});

test("P3: no --add-dir, no permission elevation, no session resuming", async () => {
  const { p, calls } = spy();
  await p.long("le transcript");
  const a = calls[0].args.join(" ");
  for (const forbidden of ["--add-dir", "--permission-mode", "--resume", "--continue", "--dangerously"]) {
    assert.ok(!a.includes(forbidden), `${forbidden} has no business here`);
  }
});

test("P3: the prompt goes on STDIN, never on the command line", async () => {
  const { p, calls } = spy();
  // cmd.exe caps a command line near 8191 characters and a meeting chunk blows
  // straight past it. This is the failure that would only appear on LONG
  // meetings, which is to say never in a test written quickly.
  const big = "x".repeat(40_000);
  await p.long(big);
  assert.equal(calls[0].stdin, big);
  assert.ok(!calls[0].args.join(" ").includes(big), "the prompt must not be an argument");
});

test("P3: the model is fixed to sonnet, and it is not a setting", async () => {
  const { p, calls } = spy();
  await p.long("t");
  const i = calls[0].args.indexOf("--model");
  assert.notEqual(i, -1);
  assert.equal(calls[0].args[i + 1], "sonnet", "a second model selector would be the setting too many");
});

test("P3: the system prompt carries the untrusted-data rule AND the no-em-dash rule", async () => {
  const { p, calls } = spy();
  await p.long("t");
  const i = calls[0].args.indexOf("--system-prompt");
  const sys = calls[0].args[i + 1];
  assert.match(sys, /UNTRUSTED DATA/, "the transcript is what third parties said; it is data");
  assert.match(sys, /em-dash|U\+2014/, "a meeting summary is a deliverable, and the rule applies");
  // The real call produced an em-dash before this line existed.
  assert.ok(!sys.includes("\u2014"), "and the instruction itself must not contain one");
});

test("P3: the working folder is dedicated and NOT the app's own", async () => {
  const { p, calls, dir } = spy();
  await p.long("t");
  assert.equal(calls[0].cwd, dir);
  assert.notEqual(calls[0].cwd, process.cwd(), "a CLI that indexes its cwd would read the user's files");
});

test("P3: the timeouts are the callers', 300 s for a summary and 25 s for live assistance", async () => {
  const { p, calls } = spy();
  await p.long("t");
  assert.equal(calls[0].timeoutMs, 300_000);
  await p.short("t", { signal: new AbortController().signal, timeoutMs: 25_000 });
  assert.equal(calls[1].timeoutMs, 25_000);
});

test("P3: it declares itself sent-away and names who receives the text", () => {
  const p = new ClaudeCliProvider({ resolve: () => "C:/fake/claude.exe" });
  assert.equal(p.locality, "sent-away");
  assert.equal(p.vendor, "Anthropic", "a provider that sends text away must name the recipient");
});

test("P3: found and responded are DIFFERENT claims", async () => {
  const dir = tempCwd();
  const p = new ClaudeCliProvider({
    resolve: () => "C:/fake/claude.exe",
    cwd: () => dir,
    run: async () => OK("des notes"),
  });
  // A claude.exe present but never signed in is the normal state of a fresh
  // machine. Saying "ready" there is a lie discovered during a meeting.
  let a = await p.available();
  assert.equal(a.found, true);
  assert.equal(a.responded, false, "nothing has come back yet");
  await p.long("t");
  a = await p.available();
  assert.equal(a.responded, true, "now something really has");
});

test("P3: a missing binary is found:false, and no call is attempted", async () => {
  let ran = false;
  const p = new ClaudeCliProvider({
    resolve: () => null,
    run: async () => {
      ran = true;
      return OK("x");
    },
  });
  const a = await p.available();
  assert.equal(a.found, false);
  assert.equal(await p.long("t"), null);
  assert.equal(ran, false);
});

test("P3: available() never spawns anything - liveAssist re-probes every 30 seconds", async () => {
  let resolves = 0;
  const p = new ClaudeCliProvider({
    resolve: () => {
      resolves++;
      return "C:/fake/claude.exe";
    },
    run: async () => {
      throw new Error("available() must never run the binary");
    },
  });
  for (let i = 0; i < 20; i++) await p.available();
  assert.equal(resolves, 1, "resolved once per process, then cached");
});

test("P3: every failure returns null and is named, never an exception", async () => {
  const dir = tempCwd();
  const seen: string[] = [];
  const p = new ClaudeCliProvider({
    resolve: () => "C:/fake/claude.exe",
    cwd: () => dir,
    run: async () => ({ stdout: "", stderr: "Not logged in", code: 1, killed: false }),
    log: (m) => seen.push(m),
  });
  assert.equal(await p.long("t"), null, "null is the contract every call site already handles");
  assert.match(seen.join(" "), /llm-not-signed-in/);
});

test("P3: 'credit balance too low' is OUR bug, not the user's account", () => {
  // On an OAuth subscription this message means the environment scrubbing let a
  // machine API key through. Telling someone to top up an account they should
  // not be using would hide our own mistake.
  assert.equal(classifyClaudeError("Credit balance is too low", 1, false), "llm-billing-env-leak");
  assert.equal(classifyClaudeError("Not logged in", 1, false), "llm-not-signed-in");
  assert.equal(classifyClaudeError("usage limit reached", 1, false), "llm-usage-limit");
  assert.equal(classifyClaudeError("", null, true), "llm-killed");
  assert.equal(classifyClaudeError("", 0, false), "llm-empty-answer");
});

test("P3: the failure name carries no path and no error text", () => {
  const name = classifyClaudeError("ENOENT C:/Users/Roch/secret/path.txt spawn failed", 1, false);
  assert.ok(!name.includes("Roch"), "a counter that carries a path is a retention leak");
  assert.ok(!name.includes("/"), "and it must not carry a path at all");
  assert.match(name, /^llm-[a-z-]+$/, "a closed vocabulary, not a message");
});
