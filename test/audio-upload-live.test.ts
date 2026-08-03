import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowClient } from "../src/main/data/client";
import { supabaseAnonKey, supabaseUrl } from "../src/shared/supabaseConfig";
import { TusUpload } from "../src/main/data/tusUpload";
import { AudioUploadQueue } from "../src/main/audioUpload";
import { TUS_CHUNK_BYTES, audioObjectName } from "../src/shared/tus";
import type { RecordingRow } from "../src/shared/recordings";

// ---------------------------------------------------------------------------
// B3c, LE TEST VIVANT : le protocole TUS contre le VRAI projet.
//
// POURQUOI IL EXISTE ALORS QUE test/audio-upload.test.ts est vert. Le faux
// serveur de l'autre fichier applique les regles que J'AI COMPRISES. Il ne peut
// pas attraper la classe d'erreur qui compte le plus ici : un en-tete mal nomme,
// un point d'entree qui a bouge, un `Upload-Metadata` que Supabase decode
// autrement que ma lecture de la spec. Ces trois-la passent tous les tests
// unitaires du monde et echouent au premier vrai televersement - apres une heure
// de reunion.
//
// C'est le meme raisonnement que test/repo-live.test.ts, et la meme concession :
// il lui faut un compte jetable, donc il SE TAIT quand .env est absent. Un test
// qui peut se taire peut se taire pour toujours ; celui-la le dit dans son
// message de saut.
//
// Il televerse DEUX tranches, delibere : une seule ne prouverait pas que
// `Upload-Offset` est lu de la reponse plutot que compte localement, ce qui est
// exactement l'erreur qui reexpedie 115 Mo.
// ---------------------------------------------------------------------------

function creds(): { email: string; password: string } | null {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const env: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].trim();
    }
    const email = env.FLOW_TEST_A_EMAIL ?? "";
    const password = env.FLOW_TEST_A_PASSWORD ?? "";
    return email && password ? { email, password } : null;
  } catch {
    return null;
  }
}

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const C = creds();

test(
  "B3c (vivant): un audio de deux tranches monte VRAIMENT dans le seau, et se relit identique",
  { skip: C ? false : "identifiants de test absents de .env (FLOW_TEST_A_*) - le protocole TUS N'A PAS ete verifie contre le vrai projet" },
  async () => {
    const c = C as { email: string; password: string };
    const client = createFlowClient({ storage: memoryStorage() });
    const signedIn = await client.auth.signInWithPassword({ email: c.email, password: c.password });
    assert.equal(signedIn.error, null, `connexion impossible : ${signedIn.error?.message}`);
    const uid = signedIn.data.session?.user.id ?? "";
    assert.ok(uid);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-tus-live-"));
    const id = "live-" + Date.now().toString(36);
    // Deux tranches PLEINES plus un reste : 6 Mo est la taille imposee, donc il
    // faut depasser 12 Mo pour que trois PATCH partent et que la lecture de
    // `Upload-Offset` soit reellement exercee.
    const total = TUS_CHUNK_BYTES * 2 + 4096;
    const payload = Buffer.alloc(total);
    for (let i = 0; i < total; i++) payload[i] = (i * 7) % 251;
    fs.writeFileSync(path.join(dir, id + ".wav"), payload);

    const objectName = audioObjectName(uid, id);
    const rows = new Map<string, RecordingRow>([
      [
        id,
        {
          id,
          title: "TUS live",
          startedIso: new Date().toISOString(),
          durationMs: 0,
          doc: "",
          audioPath: objectName,
          audioBytes: 0,
          audioUploaded: 0,
          audioUploadUrl: "",
          audioUploadExpires: "",
          staged: true,
          endedIso: new Date().toISOString(),
        },
      ],
    ]);
    const logs: string[] = [];
    const queue = new AudioUploadQueue({
      tus: new TusUpload({
        projectUrl: () => supabaseUrl(),
        anonKey: () => supabaseAnonKey(),
        accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? "",
      }),
      userId: async () => uid,
      readRow: (rid) => Promise.resolve(rows.get(rid) ?? null),
      writeRow: (r) => void rows.set(r.id, { ...r }),
      pendingDir: () => dir,
      recordingNow: () => "",
      retryDelayMs: 50,
      log: (m) => logs.push(m),
    });

    try {
      queue.enqueue(id);
      // Deux minutes de patience : c'est un vrai reseau et 12 Mo.
      for (let i = 0; i < 240 && queue.pending() > 0; i++) await new Promise((r) => setTimeout(r, 500));
      assert.equal(queue.pending(), 0, `le televersement n'a pas abouti. Journal : ${logs.join(" | ")}`);

      const row = rows.get(id)!;
      assert.equal(row.audioUploaded, total, `offset final ${row.audioUploaded} au lieu de ${total}`);
      assert.equal(row.audioUploadUrl, "", "l'adresse de televersement est relachee une fois fini");
      assert.equal(fs.existsSync(path.join(dir, id + ".wav")), false, "le .wav en transit est supprime");

      // LA VERIFICATION QUI COMPTE : l'objet existe, et c'est le bon.
      const back = await client.storage.from("recordings").download(objectName);
      assert.equal(back.error, null, `l'objet ne se relit pas : ${back.error?.message}`);
      const got = Buffer.from(await back.data!.arrayBuffer());
      assert.equal(got.length, total, "la taille ne correspond pas");
      assert.ok(got.equals(payload), "les octets remontes ne sont pas ceux qui sont partis");
    } finally {
      await client.storage.from("recordings").remove([objectName]);
      await client.auth.signOut({ scope: "local" });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
