import test from "node:test";
import assert from "node:assert/strict";
import { LocalSidecarProvider } from "../src/main/llm/localSidecar";
import { NOTES_MODEL } from "../src/main/asr/modelStore";

// ---------------------------------------------------------------------------
// P9 (vague P). Le modele qui redige les notes SUR CETTE MACHINE, sans Ollama,
// sans compte, sans rien a installer.
//
// MESURE le 2026-08-02, pas deduite : llama-server b10234 (build Vulkan) avec
// Qwen2.5-3B-Instruct-Q4_K_M a produit de VRAIES notes de reunion (Resume,
// Decisions, Actions) en 8,9 s, en laissant 11,1 Go de VRAM libres.
// ---------------------------------------------------------------------------

function fake(answer: string | null, opts: { base?: string } = {}) {
  const calls: Array<{ url: string; body: string; timeoutMs: number }> = [];
  const p = new LocalSidecarProvider({
    baseUrl: () => (opts.base === undefined ? "http://127.0.0.1:8211" : opts.base),
    fetchJson: async (url, body, timeoutMs) => {
      calls.push({ url, body, timeoutMs });
      if (answer === null) throw new Error("refused");
      return JSON.stringify({ choices: [{ message: { content: answer } }] });
    },
  });
  return { p, calls };
}

test("P9: it declares itself LOCAL and names no vendor", () => {
  const { p } = fake("x");
  assert.equal(p.locality, "on-this-machine");
  assert.equal(p.vendor, "", "un nom de destinataire sur un fournisseur local serait un mensonge");
});

test("P9: de vraies notes reviennent, et le contrat null est respecte sur echec", async () => {
  const ok = fake("### Resume\n\nDes notes.");
  assert.match((await ok.p.long("le transcript")) ?? "", /Resume/);
  const bad = fake(null);
  assert.equal(await bad.p.long("le transcript"), null, "null est le contrat que tous les appelants traitent deja");
});

test("P9: sans modele telecharge, rien n'est appele et la page le sait", async () => {
  const none = fake("x", { base: "" });
  const av = await none.p.available();
  assert.equal(av.found, false);
  assert.equal(av.detail, "local-model-not-downloaded");
  assert.equal(await none.p.long("t"), null);
  assert.equal(none.calls.length, 0, "aucun appel vers un serveur qui n'existe pas");
});

test("P9: le transcript est une DONNEE, dit avant lui dans le prompt systeme", async () => {
  const { p, calls } = fake("x");
  await p.long("le transcript");
  const body = JSON.parse(calls[0].body) as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /UNTRUSTED DATA/);
  assert.match(body.messages[0].content, /em-dash|U\+2014/, "un resume de reunion est un livrable");
  assert.equal(body.messages[1].content, "le transcript");
});

test("P9: les delais sont ceux des appelants", async () => {
  const { p, calls } = fake("x");
  await p.long("t");
  assert.equal(calls[0].timeoutMs, 300_000);
  await p.short("t", { signal: new AbortController().signal, timeoutMs: 25_000 });
  assert.equal(calls[1].timeoutMs, 25_000);
});

test("P9: le poids est epingle sur une revision immuable, avec son empreinte", () => {
  assert.match(NOTES_MODEL.revision, /^[0-9a-f]{40}$/, "une revision, jamais une branche");
  assert.match(NOTES_MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.ok(NOTES_MODEL.bytes > 1e9 && NOTES_MODEL.bytes < 3e9, "1,93 Go : tient sur une carte de 8 Go");
  // La mesure qui a decide ce poids : whisper coute ~800 MiB, donc ce n'est PAS
  // lui qui contraint. C'est la carte des autres gens.
  assert.ok(NOTES_MODEL.file.includes("Q4_K_M"), "quantifie, comme le plan le demandait");
});
