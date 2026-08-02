import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdQuoteArg, enrichedPath, resolveOnPath, runCli } from "../src/main/llm/cliRunner";

// ---------------------------------------------------------------------------
// P2 (vague P, 2026-08-02). The acceptance criterion, verbatim from the plan:
// "a test proves that a 40 KB prompt containing " and % reaches the child
// process INTACT, and that an environment polluted with ANTHROPIC_API_KEY comes
// out clean." The second half lives in test/child-env.test.ts.
//
// The 40 KB matters: cmd.exe caps a command line at ~8191 characters, so a
// prompt on the command line would fail ONLY on long meetings - never in a test
// written quickly. This one is written slowly.
// ---------------------------------------------------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-cli-"));

/** A tiny "CLI" that echoes its stdin back. The real thing under test is the
 * plumbing, not the tool. */
function echoScript(): string {
  const p = path.join(work, "echo-stdin.mjs");
  fs.writeFileSync(
    p,
    [
      "let d='';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',c=>{d+=c});",
      "process.stdin.on('end',()=>{process.stdout.write(d)});",
    ].join("\n"),
    "utf8",
  );
  return p;
}

test("P2: a 40 KB prompt full of quotes and percent signs arrives INTACT", async () => {
  const script = echoScript();
  // Built from the things a real transcript contains and that break naive
  // quoting: straight quotes, percent signs, and something that looks exactly
  // like a cmd.exe variable expansion.
  const unit = 'Il a dit "oui" a 50% -- %USERPROFILE% %PATH% et "%TEMP%"\n';
  const prompt = unit.repeat(Math.ceil(40_000 / unit.length));
  assert.ok(prompt.length >= 40_000, "the point is to be past the 8191-character command-line cap");

  const r = await runCli({
    bin: process.execPath,
    args: [script],
    stdin: prompt,
    timeoutMs: 60_000,
    cwd: work,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, prompt.trim(), "byte for byte, or the model is reading text nobody said");
  assert.ok(r.stdout.includes("%USERPROFILE%"), "a percent expansion must survive as literal text");
  assert.ok(r.stdout.includes('"oui"'), "and so must quotes");
});

test("P2: the prompt never appears on the command line", async () => {
  // The structural half of trap 1: even a short prompt goes on stdin. A test
  // that only checked the long case would let a "short prompts go on argv"
  // optimisation through.
  const script = path.join(work, "argv.mjs");
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))", "utf8");
  const r = await runCli({
    bin: process.execPath,
    args: [script, "--model", "sonnet"],
    stdin: "SECRET-PROMPT-TEXT",
    timeoutMs: 30_000,
    cwd: work,
  });
  assert.deepEqual(JSON.parse(r.stdout), ["--model", "sonnet"]);
  assert.ok(!r.stdout.includes("SECRET-PROMPT-TEXT"), "the prompt is stdin, and only stdin");
});

test("P2: cmdQuoteArg doubles internal quotes AND percent signs", () => {
  assert.equal(cmdQuoteArg("plain"), '"plain"');
  assert.equal(cmdQuoteArg('say "hi"'), '"say ""hi"""');
  assert.equal(cmdQuoteArg("50% of %USERNAME%"), '"50%% of %%USERNAME%%"');
  // The one that is easy to forget and impossible to notice: without doubling,
  // cmd.exe substitutes this and the child receives a different string. The
  // property is that NO percent sign is left single - a substring check would
  // pass on "%%TEMP%%" too, which is why it is counted instead.
  const quoted = cmdQuoteArg("%TEMP% and 100%");
  assert.equal((quoted.match(/%/g) ?? []).length, 6, "three percent signs in, six out");
  assert.ok(!/(^|[^%])%([^%]|$)/.test(quoted.slice(1, -1)), "not one lone % survives");
});

test("P2: a timeout kills the tree and comes back as a result, never as a throw", async () => {
  const script = path.join(work, "hang.mjs");
  fs.writeFileSync(script, "setInterval(()=>{},1000)", "utf8");
  const killedPids: number[] = [];
  const r = await runCli({
    bin: process.execPath,
    args: [script],
    stdin: "x",
    timeoutMs: 300,
    cwd: work,
    killTree: (pid) => {
      killedPids.push(pid);
      process.kill(pid, "SIGKILL");
    },
  });
  assert.equal(r.killed, true);
  assert.equal(killedPids.length, 1, "the TREE is killed, through the seam that stands in for taskkill");
});

test("P2: the caller's abort signal kills it too - the engine always wins", async () => {
  const script = path.join(work, "hang2.mjs");
  fs.writeFileSync(script, "setInterval(()=>{},1000)", "utf8");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await runCli({
    bin: process.execPath,
    args: [script],
    stdin: "x",
    timeoutMs: 60_000,
    signal: ac.signal,
    cwd: work,
    killTree: (pid) => process.kill(pid, "SIGKILL"),
  });
  assert.equal(r.killed, true, "an abandoned assistance round must not leave a live process consuming");
});

test("P2: a tool that does not exist is a result, not an incident", async () => {
  const r = await runCli({
    bin: path.join(work, "no-such-binary.exe"),
    args: [],
    stdin: "x",
    timeoutMs: 5_000,
    cwd: work,
  });
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.length > 0, "and it says why, in the stderr the provider will classify");
});

test("P2: resolveOnPath resolves a NAME and never runs anything", () => {
  const seen: string[] = [];
  const found = resolveOnPath("claude", { PATH: "C:/tools", USERPROFILE: "C:/u" } as NodeJS.ProcessEnv, (p) => {
    seen.push(p);
    return p === path.join("C:/tools", "claude.cmd");
  });
  assert.equal(found, path.join("C:/tools", "claude.cmd"));
  assert.ok(seen.every((p) => !p.includes("--version")), "detection is a lookup, never an execution");
});

test("P2: a .cmd shim is looked for BEFORE a .exe - it is what npm installs", () => {
  const order: string[] = [];
  resolveOnPath("claude", { PATH: "C:/tools" } as NodeJS.ProcessEnv, (p) => {
    order.push(path.extname(p) || "(none)");
    return false;
  });
  assert.equal(order[0], ".cmd", "trying .exe first would find nothing on most machines");
});

test("P2: a path is not a name - resolveOnPath refuses one", () => {
  assert.equal(resolveOnPath("C:/evil/claude.cmd", {} as NodeJS.ProcessEnv, () => true), null);
  assert.equal(resolveOnPath("../claude", {} as NodeJS.ProcessEnv, () => true), null);
  assert.equal(resolveOnPath("", {} as NodeJS.ProcessEnv, () => true), null);
});

test("P2: the enriched PATH keeps the real one first and adds the per-user install dirs", () => {
  const p = enrichedPath({ PATH: "C:/system", USERPROFILE: "C:/Users/x" } as NodeJS.ProcessEnv);
  const parts = p.split(path.delimiter);
  assert.equal(parts[0], "C:/system", "the machine's own PATH still wins");
  assert.ok(
    parts.some((d) => d.includes("npm")),
    "an Electron app launched from a shortcut does not inherit a shell PATH",
  );
});

test.after(() => fs.rmSync(work, { recursive: true, force: true }));
