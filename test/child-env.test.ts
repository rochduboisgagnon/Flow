import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { childEnv, STRIPPED_CHILD_ENV } from "../src/shared/childEnv";

// 2026-07-31, security pass. Flow's two spawn sites passed no `env` option, so
// the whisper sidecar and a PowerShell probe inherited every credential in the
// environment. Harmless-ish today; the reason to fix it now is that the
// provider wave spawns `claude`, where an inherited ANTHROPIC_API_KEY does not
// leak so much as silently BILL a machine key instead of the subscription.

test("every credential in the list is removed", () => {
  const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  for (const name of STRIPPED_CHILD_ENV) parent[name] = "secret-" + name;
  const out = childEnv(parent);
  for (const name of STRIPPED_CHILD_ENV) {
    assert.equal(out[name], undefined, `${name} must not reach a child`);
  }
  assert.equal(out.PATH, "/usr/bin", "and the child must still be able to run");
});

test("the prefix families go wholesale - they grow faster than a list", () => {
  const out = childEnv({
    PATH: "/usr/bin",
    AWS_PROFILE: "prod",
    AZURE_TENANT_ID: "t",
    npm_config_registry: "https://internal",
    npm_config__auth: "hunter2",
  });
  assert.deepEqual(Object.keys(out), ["PATH"]);
});

test("case-insensitively, because Windows env names are", () => {
  // A list written in capitals against a Windows environment that does not care
  // about case is the exact shape of a guard that looks right and does nothing.
  const out = childEnv({ PATH: "/usr/bin", aws_secret_access_key: "leak", Node_Options: "--require /evil.js" });
  assert.equal(out.aws_secret_access_key, undefined);
  assert.equal(out.Node_Options, undefined, "NODE_OPTIONS is arbitrary code in a Node child, not a secret");
});

test("NODE_OPTIONS and ELECTRON_RUN_AS_NODE are stripped, and they are not secrets", () => {
  // Worth its own test: these two are the ones a reviewer skips because they
  // look like configuration. NODE_OPTIONS can inject `--require` into any Node
  // child; ELECTRON_RUN_AS_NODE changes what an Electron binary IS.
  const out = childEnv({ NODE_OPTIONS: "--require /tmp/x.js", ELECTRON_RUN_AS_NODE: "1", PATH: "p" });
  assert.deepEqual(Object.keys(out), ["PATH"]);
});

test("the parent environment is never mutated", () => {
  // process.env is shared with the whole app. A function that quietly emptied
  // it would break Flow in a way nobody would trace back here.
  const parent: NodeJS.ProcessEnv = { PATH: "p", ANTHROPIC_API_KEY: "k" };
  childEnv(parent);
  assert.equal(parent.ANTHROPIC_API_KEY, "k");
});

test("both spawn sites actually USE it - the helper existing proves nothing", () => {
  // A pure function with no caller is how this whole class of fix fails.
  for (const rel of ["src/main/asr/sidecar.ts", "src/main/focus/probe.ts"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.match(src, /env: childEnv\(\)/, `${rel} must hand its child a scrubbed environment`);
  }
});

test("and no OTHER spawn site was added without one", () => {
  // The guard against the next call site copying the pattern beside it.
  const roots = ["src/main", "src/shared"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(__dirname, "..", dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".ts")) files.push(rel);
    }
  };
  roots.forEach(walk);
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // `spawn(` at a call site, not in a comment or a type.
    const spawns = src.match(/^\s*(?:const \w+ = )?spawn\(/gm) ?? [];
    if (spawns.length === 0) continue;
    assert.match(src, /childEnv\(\)/, `${rel} spawns a child and must scrub its environment`);
  }
});

// ---------------------------------------------------------------------------
// P2 (vague P, 2026-08-02). The wave spawns `claude`, and an inherited billing
// variable there does not merely leak - it silently bills a machine key instead
// of the subscription. The exact list had five of the family and missed
// ANTHROPIC_CUSTOM_HEADERS, which is the argument for prefixes made concrete.
// ---------------------------------------------------------------------------

test("P2: the whole ANTHROPIC_ family is stripped, including names nobody enumerated", () => {
  const out = childEnv({
    PATH: "keep-me",
    SystemRoot: "keep-me-too",
    ANTHROPIC_API_KEY: "k",
    ANTHROPIC_CUSTOM_HEADERS: "h", // the one the exact list missed
    ANTHROPIC_SOMETHING_INVENTED_LATER: "x", // and the ones nobody has written yet
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    ELECTRON_RUN_AS_NODE: "1",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(Object.keys(out).sort(), ["PATH", "SystemRoot"]);
});

test("P2: the prefix rule is case-insensitive, like Windows itself", () => {
  const out = childEnv({ PATH: "x", anthropic_base_url: "b", Claude_Code_Use_Vertex: "1" } as NodeJS.ProcessEnv);
  assert.deepEqual(Object.keys(out), ["PATH"], "lowercase must not walk through a list written in capitals");
});

test("P2: PATH survives, because a child that cannot find its own tools is not safer", () => {
  const out = childEnv({ PATH: "C:/tools", SystemRoot: "C:/Windows", TEMP: "C:/t" } as NodeJS.ProcessEnv);
  assert.equal(out.PATH, "C:/tools");
  assert.equal(out.SystemRoot, "C:/Windows");
  assert.equal(out.TEMP, "C:/t");
});
