import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TUS_CHUNK_BYTES,
  TUS_PATCH_CONTENT_TYPE,
  TUS_VERSION,
  audioObjectName,
  cacheControlSeconds,
  chunkCount,
  encodeUploadMetadata,
  nextChunk,
  readUploadExpires,
  readUploadOffset,
  uploadIsGone,
} from "../src/shared/tus";
import { TusUpload } from "../src/main/data/tusUpload";
import { AudioUploadQueue, AUDIO_BUCKET, wavBytesForMs } from "../src/main/audioUpload";
import type { RecordingRow } from "../src/shared/recordings";

// ---------------------------------------------------------------------------
// B3c (A4) : « Un televersement de 115 Mo interrompu reprend. »
//
// C'est la condition de fin que le plan ecrit pour cette tache. Ce fichier la
// prouve sur un vrai fichier, avec un vrai decoupage en tranches de 6 Mo, contre
// un faux serveur TUS qui applique les MEMES regles que Supabase Storage :
// l'offset doit correspondre ou c'est 409, un PATCH reussi rend 204 avec le
// nouvel offset, et une URL inconnue rend 410.
//
// La partie qui merite le plus d'egards est l'encodage des metadonnees : une
// erreur y est SILENCIEUSE (le seau tombe a "", le cache tombe en no-cache) et
// ne se voit qu'a l'execution, apres une heure de reunion.
// ---------------------------------------------------------------------------

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

test("B3c: Upload-Metadata encode les VALEURS en base64, les cles en clair", () => {
  const out = encodeUploadMetadata({ bucketName: "recordings", objectName: "uid-42/rec.wav" });
  assert.equal(out, "bucketName cmVjb3JkaW5ncw==,objectName dWlkLTQyL3JlYy53YXY=");
  // Base64 STANDARD et non base64url : c'est ce que la spec impose, et un
  // objectName avec un tiret ou un souligne echouerait sur l'autre alphabet.
  assert.equal(Buffer.from("cmVjb3JkaW5ncw==", "base64").toString(), "recordings");
  assert.equal(Buffer.from("dWlkLTQyL3JlYy53YXY=", "base64").toString(), "uid-42/rec.wav");
});

test("B3c: une valeur vide est OMISE plutot qu'envoyee vide", () => {
  // `bucketName` absent fait lever MetadataRequired cote serveur - un message
  // clair. Un bucketName VIDE fait chercher un seau nomme "", et le message
  // parle alors d'un seau introuvable.
  assert.equal(encodeUploadMetadata({ bucketName: "", objectName: "a" }), "objectName YQ==");
  assert.equal(encodeUploadMetadata({}), "");
});

test("B3c: cacheControl part en CHIFFRES - « max-age=3600 » tomberait en no-cache", () => {
  // Le serveur teste /^-?\d+$/ et convertit lui-meme. La forme qui a l'air juste
  // desactive le cache sans le dire.
  assert.equal(cacheControlSeconds(3600), "3600");
  assert.equal(cacheControlSeconds(-5), "0");
  assert.ok(/^\d+$/.test(cacheControlSeconds(1.9)));
});

test("B3c: la taille de tranche est 6 Mo, et ce n'est pas un reglage", () => {
  assert.equal(TUS_CHUNK_BYTES, 6 * 1024 * 1024);
  assert.equal(TUS_VERSION, "1.0.0");
  assert.equal(TUS_PATCH_CONTENT_TYPE, "application/offset+octet-stream");
});

test("B3c: le decoupage rend des tranches pleines, sauf la derniere", () => {
  const total = TUS_CHUNK_BYTES * 2 + 1234;
  assert.deepEqual(nextChunk(0, total), { start: 0, length: TUS_CHUNK_BYTES, last: false });
  assert.deepEqual(nextChunk(TUS_CHUNK_BYTES, total), { start: TUS_CHUNK_BYTES, length: TUS_CHUNK_BYTES, last: false });
  assert.deepEqual(nextChunk(TUS_CHUNK_BYTES * 2, total), { start: TUS_CHUNK_BYTES * 2, length: 1234, last: true });
  assert.equal(nextChunk(total, total).length, 0, "tout est arrive : plus rien a envoyer");
  assert.equal(chunkCount(total), 3);
  assert.equal(chunkCount(0), 0);
});

test("B3c: un offset absent rend NULL et non zero", () => {
  // La distinction est la seule chose qui empeche de reexpedier 115 Mo : « cette
  // reponse ne dit pas ou on en est » n'est pas « on en est a zero ».
  assert.equal(readUploadOffset(h({})), null);
  assert.equal(readUploadOffset(h({ "upload-offset": "pas un nombre" })), null);
  assert.equal(readUploadOffset(h({ "upload-offset": "0" })), 0);
  assert.equal(readUploadOffset(h({ "upload-offset": " 6291456 " })), 6291456);
});

test("B3c: l'expiration vient du SERVEUR, pas d'une arithmetique locale", () => {
  assert.equal(readUploadExpires(h({})), "");
  assert.equal(readUploadExpires(h({ "upload-expires": "n'importe quoi" })), "");
  assert.equal(readUploadExpires(h({ "upload-expires": "Tue, 04 Aug 2026 14:00:00 GMT" })), "2026-08-04T14:00:00.000Z");
});

test("B3c: 404, 410 et 403 veulent tous dire « recommence »", () => {
  for (const s of [404, 410, 403]) assert.equal(uploadIsGone(s), true);
  for (const s of [200, 204, 409, 412, 500]) assert.equal(uploadIsGone(s), false);
});

test("B3c: le chemin de l'objet commence par le compte - c'est la frontiere du RLS", () => {
  // Les politiques de la premiere migration n'autorisent que
  // (storage.foldername(name))[1] = auth.uid(). Un chemin sans ce prefixe est
  // refuse, et le refus arriverait apres une heure de reunion.
  assert.equal(audioObjectName("u-1", "r-2"), "u-1/r-2.wav");
  assert.equal(audioObjectName("u-1", "r-2").split("/")[0], "u-1");
});

test("B3c: 115 Mo pour une heure - le chiffre du plan, calcule", () => {
  const oneHour = wavBytesForMs(60 * 60 * 1000);
  assert.equal(oneHour, 44 + 3600 * 16_000 * 2);
  assert.equal(Math.round(oneHour / (1024 * 1024)), 110, "110 Mio, soit 115 Mo decimaux");
});

// ---------------------------------------------------------------------------
// UN FAUX SERVEUR TUS, avec les regles de Supabase Storage
// ---------------------------------------------------------------------------

interface FakeServerOpts {
  /** Coupe le reseau apres avoir accepte tant d'octets. */
  cutAfterBytes?: number;
  /** Rend 410 sur tout : l'URL a expire. */
  gone?: boolean;
  /** Rend un 409 sur le PATCH numero n (1-indexe), une seule fois. */
  conflictOnPatch?: number;
}

function fakeTusServer(opts: FakeServerOpts = {}) {
  const uploads = new Map<string, { offset: number; total: number; objectName: string; bytes: Buffer }>();
  const requests: string[] = [];
  let seq = 0;
  let patches = 0;
  let cut = false;
  const metaSeen: string[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    requests.push(`${method} ${url.includes("/upload/resumable/") ? "<upload>" : url}`);

    if (opts.gone) return new Response(null, { status: 410 });

    if (method === "POST") {
      // Les regles que le serveur applique vraiment.
      assert.equal(headers.get("tus-resumable"), TUS_VERSION, "Tus-Resumable manquant : le serveur rendrait 412");
      assert.ok(headers.get("authorization")?.startsWith("Bearer "), "chaque requete non-HEAD est autorisee");
      assert.equal(headers.get("x-upsert"), "true", "la chaine litterale 'true', rien d'autre ne marche");
      const meta = headers.get("upload-metadata") ?? "";
      metaSeen.push(meta);
      const fields = new Map(meta.split(",").map((p) => {
        const [k, v] = p.split(" ");
        return [k, Buffer.from(v ?? "", "base64").toString("utf8")];
      }));
      assert.equal(fields.get("bucketName"), AUDIO_BUCKET);
      const total = Number(headers.get("upload-length"));
      const id = "u" + ++seq;
      uploads.set(id, { offset: 0, total, objectName: fields.get("objectName") ?? "", bytes: Buffer.alloc(0) });
      return new Response(null, {
        status: 201,
        headers: { location: `https://x.test/storage/v1/upload/resumable/${id}`, "tus-resumable": TUS_VERSION },
      });
    }

    const id = url.split("/").pop() ?? "";
    const up = uploads.get(id);
    if (!up) return new Response(null, { status: 410 });

    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "upload-offset": String(up.offset), "upload-length": String(up.total), "tus-resumable": TUS_VERSION },
      });
    }

    if (method === "PATCH") {
      assert.equal(headers.get("content-type"), TUS_PATCH_CONTENT_TYPE, "sinon 415 et rien n'avance");
      assert.ok(headers.get("authorization")?.startsWith("Bearer "), "le RLS est reevalue a chaque PATCH");
      patches++;
      if (opts.conflictOnPatch === patches) return new Response(null, { status: 409 });
      const at = Number(headers.get("upload-offset"));
      if (at !== up.offset) return new Response(null, { status: 409 });
      const body = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
      // Toutes les tranches sauf la derniere doivent etre pleines : S3 refuse une
      // partie de moins de 5 Mo ailleurs qu'en fin de fichier.
      if (at + body.length < up.total) {
        assert.equal(body.length, TUS_CHUNK_BYTES, "une tranche intermediaire doit faire exactement 6 Mo");
      }
      if (opts.cutAfterBytes !== undefined && !cut && up.offset + body.length > opts.cutAfterBytes) {
        cut = true;
        throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
      }
      up.bytes = Buffer.concat([up.bytes, body]);
      up.offset += body.length;
      const done = up.offset >= up.total;
      return new Response(null, {
        status: 204,
        headers: {
          "upload-offset": String(up.offset),
          "tus-resumable": TUS_VERSION,
          ...(done ? { "tus-complete": "1" } : {}),
        },
      });
    }
    return new Response(null, { status: 405 });
  };

  return { fetchImpl, uploads, requests, metaSeen, patchCount: () => patches, healed: () => void (cut = true) };
}

function row(id: string, over: Partial<RecordingRow> = {}): RecordingRow {
  return {
    id,
    title: "Reunion",
    startedIso: "2026-08-03T14:00:00.000Z",
    durationMs: 3_600_000,
    doc: "# Reunion\n\n",
    audioPath: `uid-1/${id}.wav`,
    audioBytes: 0,
    audioUploaded: 0,
    audioUploadUrl: "",
    audioUploadExpires: "",
    staged: true,
    endedIso: "2026-08-03T15:00:00.000Z",
    ...over,
  };
}

/** La file, un vrai fichier sur le disque, et un faux serveur. */
function harness(o: { bytes: number; server?: FakeServerOpts; id?: string; rowOver?: Partial<RecordingRow> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-"));
  const id = o.id ?? "rec-1";
  // Un contenu reconnaissable : chaque octet est son index modulo 251, ce qui
  // permet de verifier que ce qui arrive est bien ce qui est parti, dans l'ordre.
  const payload = Buffer.alloc(o.bytes);
  for (let i = 0; i < o.bytes; i++) payload[i] = i % 251;
  fs.writeFileSync(path.join(dir, id + ".wav"), payload);

  const server = fakeTusServer(o.server);
  const rows = new Map<string, RecordingRow>([[id, row(id, o.rowOver)]]);
  const logs: string[] = [];
  /** Les reprises que la file a programmees. Les tests les declenchent
   * eux-memes : attendre une vraie temporisation rendrait la suite lente ET
   * dependante de l'horloge. */
  const retries: Array<() => void> = [];
  const queue = new AudioUploadQueue({
    tus: new TusUpload({
      projectUrl: () => "https://x.test",
      anonKey: () => "publishable",
      accessToken: () => Promise.resolve("jeton-de-session"),
      fetchImpl: server.fetchImpl,
    }),
    userId: () => Promise.resolve("uid-1"),
    readRow: (rid) => Promise.resolve(rows.get(rid) ?? null),
    writeRow: (r) => void rows.set(r.id, { ...r }),
    pendingDir: () => dir,
    recordingNow: () => "",
    retryDelayMs: 1,
    schedule: (fn) => void retries.push(fn),
    log: (m) => logs.push(m),
  });
  return {
    dir,
    id,
    payload,
    server,
    rows,
    queue,
    logs,
    /** Declenche la reprise que la file attendait. */
    retry: () => {
      const next = retries.shift();
      assert.ok(next, "la file devait avoir programme une reprise");
      next();
    },
    retries,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5));
};

test("B3c: un audio de plusieurs tranches monte en entier, et le .wav en transit disparait", async () => {
  const bytes = TUS_CHUNK_BYTES * 2 + 5000;
  const t = harness({ bytes });
  t.queue.enqueue(t.id);
  await settle();

  const up = [...t.server.uploads.values()][0];
  assert.equal(up.offset, bytes, "tout est arrive");
  assert.ok(up.bytes.equals(t.payload), "et c'est bien le fichier, octet pour octet");
  assert.equal(up.objectName, `uid-1/${t.id}.wav`, "sous un chemin prefixe par le compte");
  assert.equal(t.server.patchCount(), 3, "trois tranches pour 12 Mo et des miettes");

  const r = t.rows.get(t.id)!;
  assert.equal(r.audioUploaded, bytes);
  assert.equal(r.audioBytes, bytes);
  assert.equal(r.audioUploadUrl, "", "l'adresse de televersement n'a plus de raison d'etre gardee");
  assert.equal(fs.existsSync(path.join(t.dir, t.id + ".wav")), false, "le fichier de transit est supprime");
  t.cleanup();
});

test("B3c: UN TELEVERSEMENT INTERROMPU REPREND - sans reexpedier ce qui a atterri", async () => {
  // La condition de fin du plan. Le reseau tombe au milieu de la deuxieme
  // tranche ; la reprise doit repartir de l'offset que le SERVEUR confirme.
  const bytes = TUS_CHUNK_BYTES * 3 + 777;
  const t = harness({ bytes, server: { cutAfterBytes: TUS_CHUNK_BYTES } });
  t.queue.enqueue(t.id);
  await settle();

  const afterCut = t.rows.get(t.id)!;
  assert.ok(afterCut.audioUploadUrl, "l'adresse est PERSISTEE : c'est ce qui rend la reprise possible");
  assert.equal(afterCut.audioUploaded, TUS_CHUNK_BYTES, "et l'offset confirme est garde");
  assert.ok(t.logs.some((m) => /injoignable/.test(m)), "la coupure est dite, pas avalee");
  const patchesBefore = t.server.patchCount();

  // Le reseau revient, et la file reprend LE MEME travail : il n'a jamais quitte
  // la tete de la file, exactement comme dans la copie de travail.
  assert.equal(t.retries.length, 1, "une reprise etait programmee");
  t.retry();
  await settle();

  const up = [...t.server.uploads.values()][0];
  assert.equal(up.offset, bytes, "tout est arrive apres la reprise");
  assert.ok(up.bytes.equals(t.payload), "et le fichier reconstitue est identique");
  // LA MESURE QUI COMPTE : la premiere tranche n'est pas repartie. Quatre
  // tranches au total pour 18 Mo + 777 o, dont une refusee par la coupure.
  assert.equal(t.server.patchCount() - patchesBefore, 3, "la reprise n'envoie que ce qui restait");
  assert.equal(t.server.uploads.size, 1, "un SEUL televersement ouvert : l'URL est reutilisee, pas recreee");
  t.cleanup();
});

test("B3c: une URL expiree fait recommencer proprement, avec une nouvelle adresse", async () => {
  const bytes = 1000;
  const t = harness({
    bytes,
    rowOver: {
      audioUploadUrl: "https://x.test/storage/v1/upload/resumable/disparue",
      audioBytes: bytes,
      audioUploaded: 500,
    },
  });
  t.queue.enqueue(t.id);
  await settle();
  const up = [...t.server.uploads.values()][0];
  assert.ok(up, "un nouveau televersement a ete ouvert");
  assert.equal(up.offset, bytes);
  assert.ok(up.bytes.equals(t.payload));
  t.cleanup();
});

test("B3c: une adresse expiree PAR SA DATE ne coute meme pas une requete", async () => {
  // Decouvrir l'expiration sur un PATCH couterait 6 Mo. La date annoncee par le
  // serveur est verifiee avant.
  const t = harness({
    bytes: 1000,
    rowOver: {
      audioUploadUrl: "https://x.test/storage/v1/upload/resumable/vieille",
      audioUploadExpires: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  t.queue.enqueue(t.id);
  await settle();
  assert.equal(t.server.requests.filter((r) => r.startsWith("HEAD")).length, 0, "aucun HEAD sur une adresse dont on sait qu'elle est morte");
  assert.ok(t.logs.some((m) => /a expire/.test(m)));
  assert.equal([...t.server.uploads.values()][0].offset, 1000, "et le televersement neuf va au bout");
  t.cleanup();
});

test("B3c: un 409 fait redemander l'offset au serveur au lieu de deviner", async () => {
  const bytes = TUS_CHUNK_BYTES + 10;
  const t = harness({ bytes, server: { conflictOnPatch: 1 } });
  t.queue.enqueue(t.id);
  await settle();
  assert.ok(t.server.requests.some((r) => r.startsWith("HEAD")), "un conflit se resout par un HEAD");
  const up = [...t.server.uploads.values()][0];
  assert.equal(up.offset, bytes, "et le televersement finit quand meme");
  assert.ok(up.bytes.equals(t.payload));
  t.cleanup();
});

test("B3c: la progression est LISIBLE pendant le transfert", async () => {
  const bytes = TUS_CHUNK_BYTES * 2;
  const t = harness({ bytes, server: { cutAfterBytes: TUS_CHUNK_BYTES } });
  t.queue.enqueue(t.id);
  await settle();
  // Apres la coupure, la ligne porte ce qui est arrive : c'est ce que la page
  // affiche (« 6 sur 12 Mo »), et ca survit a un redemarrage.
  const r = t.rows.get(t.id)!;
  assert.equal(r.audioUploaded, TUS_CHUNK_BYTES);
  assert.equal(r.audioBytes, bytes);
  assert.equal(chunkCount(r.audioBytes), 2);
  t.cleanup();
});

test("B3c: une reunion qui ne garde pas son audio voit son .wav en transit supprime", async () => {
  const t = harness({ bytes: 500, rowOver: { audioPath: "" } });
  t.queue.enqueue(t.id);
  await settle();
  assert.equal(fs.existsSync(path.join(t.dir, t.id + ".wav")), false);
  assert.equal(t.server.uploads.size, 0, "et rien n'est televerse");
  t.cleanup();
});

test("B3c: le balayage du lancement reprend ce qui reste et nettoie ce qui est fini", async () => {
  const t = harness({ bytes: 400 });
  // Un deuxieme fichier, dont la ligne dit que l'audio est deja arrive.
  fs.writeFileSync(path.join(t.dir, "deja-monte.wav"), Buffer.alloc(400));
  t.rows.set("deja-monte", row("deja-monte", { audioBytes: 400, audioUploaded: 400 }));
  // Un troisieme, dont la ligne est introuvable : on n'y touche PAS.
  fs.writeFileSync(path.join(t.dir, "orphelin.wav"), Buffer.alloc(400));

  const resumed = await t.queue.resumePending();
  await settle();

  assert.equal(resumed, 1, "un seul televersement a reprendre");
  assert.equal(fs.existsSync(path.join(t.dir, "deja-monte.wav")), false, "celui qui est arrive est nettoye");
  assert.equal(fs.existsSync(path.join(t.dir, "orphelin.wav")), true, "celui qu'on ne sait pas classer est LAISSE");
  assert.ok(t.logs.some((m) => /introuvable/.test(m)), "et signale");
  assert.equal([...t.server.uploads.values()][0].offset, 400);
  t.cleanup();
});

test("B3c: le .wav de la reunion EN COURS n'est ni televerse ni supprime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-audio-live-"));
  fs.writeFileSync(path.join(dir, "en-cours.wav"), Buffer.alloc(100));
  const server = fakeTusServer();
  const queue = new AudioUploadQueue({
    tus: new TusUpload({
      projectUrl: () => "https://x.test",
      anonKey: () => "k",
      accessToken: () => Promise.resolve("t"),
      fetchImpl: server.fetchImpl,
    }),
    userId: () => Promise.resolve("uid-1"),
    readRow: () => Promise.resolve(null),
    writeRow: () => {},
    pendingDir: () => dir,
    recordingNow: () => "en-cours",
    retryDelayMs: 1,
    schedule: () => {},
  });
  assert.equal(await queue.resumePending(), 0);
  assert.equal(fs.existsSync(path.join(dir, "en-cours.wav")), true, "on n'arrache pas le fichier qu'une reunion ecrit");
  assert.equal(server.uploads.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B3c: le jeton ne peut pas fuir par le journal", () => {
  // Sixieme des sept regressions du plan. Une lecture du source, parce qu'une
  // fuite ne se voit pas dans un resultat : elle se voit dans flow.log, plus
  // tard, chez quelqu'un.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main", "data", "tusUpload.ts"), "utf8");
  for (const m of src.matchAll(/log\?\.\(([^;]*)\)/g)) {
    assert.ok(!/token|authorization|Bearer/i.test(m[1]), `un appel de journalisation mentionne le jeton : ${m[1]}`);
  }
  // Et le jeton n'est jamais RANGE : il arrive par une fonction a chaque requete.
  assert.ok(!/this\.token\s*=/.test(src), "le jeton ne doit pas etre garde dans un champ");
  assert.ok(src.includes("accessToken(): Promise<string>"), "il arrive par une fonction");
});
