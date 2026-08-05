import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import type https from "node:https";
import { fetchToFile } from "../src/main/net/fetchVerified";

// ---------------------------------------------------------------------------
// 2026-08-04 : LA GARDE DE TRONCATURE, EPROUVEE POUR LA PREMIERE FOIS.
//
// Ce corps existe depuis F8 et n'avait aucun test unitaire, parce que l'eprouver
// demandait un serveur qui MENT sur son content-length. Il vivait dans une
// fonction privee de asr/modelStore.ts, et il decidait pourtant si un gigaoctet
// d'octets a moitie arrives avait le droit de prendre le nom que le moteur charge.
//
// Le portage macOS l'a sorti de la (le canal mac a le meme besoin), et la couture
// d'injection `get` qui rend le partage propre rend AUSSI ces tests possibles.
// C'est le vrai gain de l'extraction, plus que la reutilisation.
// ---------------------------------------------------------------------------

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flow-fetch-")), "out.bin");
}

/** Une reponse HTTP a la main. `declaredLength` peut MENTIR : c'est tout
 * l'interet, et c'est ce qu'une connexion coupee produit vraiment. */
function fakeGet(
  steps: Array<{ status: number; location?: string; body?: string; declaredLength?: number }>,
): { get: typeof https.get; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const get = ((url: string, cb: (res: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    calls.push(String(url));
    const step = steps[Math.min(i++, steps.length - 1)];
    const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
    res.statusCode = step.status;
    res.headers = {};
    if (step.location) res.headers.location = step.location;
    const body = step.body ?? "";
    if (step.status === 200) {
      res.headers["content-length"] = String(step.declaredLength ?? Buffer.byteLength(body));
    }
    // Le rappel doit recevoir la reponse AVANT que les octets arrivent, comme le
    // vrai https.get : brancher les ecouteurs puis ecrire.
    setImmediate(() => {
      cb(res);
      setImmediate(() => {
        if (body) res.write(body);
        res.end();
      });
    });
    return { on: () => ({}) } as unknown as ReturnType<typeof https.get>;
  }) as unknown as typeof https.get;
  return { get, calls };
}

const ALLOW_ALL = () => true;

test("FV-1: the fingerprint is of the bytes that actually arrived", async () => {
  const dest = tmpFile();
  const body = "les octets exacts, accentues : ete, ou, ca";
  const { get } = fakeGet([{ status: 200, body }]);
  const digest = await fetchToFile({ url: "https://x/y", dest, redirectAllowed: ALLOW_ALL, get });
  assert.equal(digest, crypto.createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"));
  assert.equal(fs.readFileSync(dest, "utf8"), body);
});

test("FV-2: a SHORT file whose server promised more is deleted and refused", async () => {
  // Le cas reel : une connexion coupee termine le flux PROPREMENT avec un fichier
  // court. Sans cette garde, un modele a moitie telecharge prend le nom que le
  // moteur charge, et la panne se presente comme un moteur qui refuse de demarrer.
  const dest = tmpFile();
  const { get } = fakeGet([{ status: 200, body: "60 octets seulement", declaredLength: 100_000 }]);
  await assert.rejects(
    fetchToFile({ url: "https://x/y", dest, redirectAllowed: ALLOW_ALL, get, what: "macOS update" }),
    /truncated: got 19 of 100000 bytes/,
  );
  assert.equal(fs.existsSync(dest), false, "le fichier tronque est reste sur le disque");
});

test("FV-3: the error names WHAT was being downloaded", async () => {
  // Sans le parametre `what`, un echec de mise a jour macOS parlait de « model ».
  const dest = tmpFile();
  const { get } = fakeGet([{ status: 404 }]);
  await assert.rejects(
    fetchToFile({ url: "https://x/y", dest, redirectAllowed: ALLOW_ALL, get, what: "macOS update" }),
    /macOS update download failed: HTTP 404/,
  );
});

test("FV-4: a redirect off the allowlist is refused, and the error NAMES the host", async () => {
  // Le mode d'echec est diagnostique par choix : GitHub et HuggingFace ont deja
  // change leur cible de redirection. Sans l'hote dans le message, la panne se
  // presente comme « les mises a jour ne marchent plus ».
  const dest = tmpFile();
  const { get } = fakeGet([{ status: 302, location: "https://evil.example/pkg.zip" }]);
  await assert.rejects(
    fetchToFile({
      url: "https://github.com/y",
      dest,
      redirectAllowed: (u) => new URL(u).hostname === "github.com",
      get,
      what: "macOS update",
    }),
    /refusing a macOS update redirect off the pinned host: https:\/\/evil\.example\/pkg\.zip/,
  );
});

test("FV-5: an allowed redirect IS followed, and the digest is of the final body", async () => {
  const dest = tmpFile();
  const body = "le vrai contenu";
  const { get, calls } = fakeGet([
    { status: 302, location: "https://release-assets.githubusercontent.com/z" },
    { status: 200, body },
  ]);
  const digest = await fetchToFile({ url: "https://github.com/y", dest, redirectAllowed: ALLOW_ALL, get });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://release-assets.githubusercontent.com/z");
  assert.equal(digest, crypto.createHash("sha256").update(body).digest("hex"));
});

test("FV-6: a redirect loop stops at five hops instead of forever", async () => {
  const dest = tmpFile();
  const { get, calls } = fakeGet([{ status: 302, location: "https://x/loop" }]);
  await assert.rejects(fetchToFile({ url: "https://x/y", dest, redirectAllowed: ALLOW_ALL, get }), /too many redirects/);
  assert.ok(calls.length <= 7, `trop d'appels avant l'arret : ${calls.length}`);
});

test("FV-7: a server that declares nothing is accepted, because many do", async () => {
  // content-length absent = la garde de troncature ne peut rien affirmer. Elle
  // s'abstient plutot que d'inventer : refuser ici casserait les serveurs qui
  // repondent en chunked.
  const dest = tmpFile();
  const body = "sans content-length";
  const get = ((url: string, cb: (res: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    void url;
    const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
    res.statusCode = 200;
    res.headers = {};
    setImmediate(() => {
      cb(res);
      setImmediate(() => {
        res.write(body);
        res.end();
      });
    });
    return { on: () => ({}) } as unknown as ReturnType<typeof https.get>;
  }) as unknown as typeof https.get;
  const digest = await fetchToFile({ url: "https://x/y", dest, redirectAllowed: ALLOW_ALL, get });
  assert.equal(digest, crypto.createHash("sha256").update(body).digest("hex"));
});

test("FV-8: modelStore still passes its OWN allowlist, not a widened one", () => {
  // La raison pour laquelle l'allowlist est un parametre et non une valeur du
  // module partage : un telechargement de modele ne doit jamais pouvoir atterrir
  // sur un hote GitHub, meme maintenant que le meme code sert les deux.
  const src = fs.readFileSync(path.join(process.cwd(), "src", "main", "asr", "modelStore.ts"), "utf8");
  assert.match(src, /fetchToFile\(\{[^}]*redirectAllowed[^}]*\}\)/s);
  assert.doesNotMatch(src, /githubReleaseRedirectAllowed/, "l'allowlist des modeles a ete elargie a GitHub");
});
