import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OllamaProvider, type LlmProvider } from "../src/main/llm/provider";

// ---------------------------------------------------------------------------
// P1 (vague P, 2026-08-02). The boundary behind which "who thinks for Flow"
// lives. Get this wrong and the whole wave derails, so the tests are about the
// SHAPE as much as the behaviour.
//
// The headline criterion of P1 is not in this file: it is that the other 1029
// tests pass with no assertion changed. That is what proves the local
// behaviour was preserved rather than re-specified.
// ---------------------------------------------------------------------------

test("P1: the source tree no longer names Ollama outside the provider module", () => {
  // The mechanical half of P1's acceptance criterion, kept as a test so it
  // cannot rot back. `llm/ollama` may be imported by exactly one file.
  const root = path.join(__dirname, "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && fs.readFileSync(p, "utf8").includes("llm/ollama")) {
        offenders.push(path.relative(root, p).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, ["main/llm/provider.ts"], "only the provider module may know the word");
});

test("P1: the model resolution is the one that used to be copy-pasted, exactly", () => {
  // Preferred wins; absent, the first installed; absent, nothing. These three
  // lines lived identically in longform.finalize AND audioImport.
  const withPref = new OllamaProvider({ preferredModel: () => "gemma3:12b", listModels: async () => ["a", "b"] });
  const noPref = new OllamaProvider({ preferredModel: () => "", listModels: async () => ["first", "second"] });
  const nothing = new OllamaProvider({ preferredModel: () => "", listModels: async () => null });
  return Promise.all([
    withPref.resolveModel().then((m) => assert.equal(m, "gemma3:12b")),
    noPref.resolveModel().then((m) => assert.equal(m, "first")),
    nothing.resolveModel().then((m) => assert.equal(m, "")),
  ]);
});

test("P1: no model installed means available() says so, and long/short return null WITHOUT calling out", async () => {
  // The important half: with nothing installed, neither verb may reach the
  // network. A summary path that tried anyway would hang a finalize for five
  // minutes on a machine that simply has no Ollama.
  const p = new OllamaProvider({ preferredModel: () => "", listModels: async () => null });
  const av = await p.available();
  assert.equal(av.found, false);
  assert.equal(av.responded, false);
  assert.equal(await p.long("anything"), null);
  assert.equal(await p.short("anything", { signal: new AbortController().signal, timeoutMs: 25_000 }), null);
});

test("P1: the local provider declares itself local, and carries no vendor", () => {
  const p = new OllamaProvider({ preferredModel: () => "x" });
  assert.equal(p.locality, "on-this-machine");
  assert.equal(p.vendor, "", "a vendor name on a local provider would be a lie the UI would repeat");
  assert.equal(p.id, "ollama");
});

test("P1: the interface is satisfiable by something that is not Ollama", () => {
  // The whole point of the wave. If this stops compiling, the boundary has
  // grown an Ollama-shaped assumption.
  const fake: LlmProvider = {
    id: "claude-cli",
    locality: "sent-away",
    vendor: "Anthropic",
    available: async () => ({ found: true, responded: false, detail: "not signed in" }),
    long: async () => "notes",
    short: async () => null,
  };
  assert.equal(fake.locality, "sent-away");
  assert.notEqual(fake.vendor, "", "a provider that sends text away must name who receives it");
});

test("P1: locality is what the UI reads - every provider must declare one", () => {
  // A provider whose locality had to be inferred from its id is how a page ends
  // up saying "local" about something that is not.
  const p = new OllamaProvider({ preferredModel: () => "x" });
  const localities: string[] = [p.locality];
  assert.ok(localities.every((l) => l === "on-this-machine" || l === "sent-away"));
});
