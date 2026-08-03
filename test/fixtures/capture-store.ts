import type { CaptureStore } from "../../src/main/longform";
import type { OpenRecording, RecordingRow } from "../../src/shared/recordings";

// ---------------------------------------------------------------------------
// B3 : le magasin d'une capture, en memoire, pour les tests.
//
// Il tient LE MEME contrat que WorkingCopyCaptureStore : `write` est synchrone
// et ne lance pas, la derniere ecriture d'un identifiant remplace les
// precedentes (comme la file coalescee de la copie de travail), et il peut
// tomber hors ligne.
//
// HORS LIGNE, il fait exactement ce que la vraie file fait : il GARDE ce qu'on
// lui donne et compte ce qui n'est pas monte. C'est ce qui permet de verifier
// « une coupure de dix minutes au milieu ne perd rien » sans reseau ni compte.
// ---------------------------------------------------------------------------

export interface FakeCaptureStore extends CaptureStore {
  /** Ce qui est arrive « chez Supabase ». */
  rows: Map<string, RecordingRow>;
  /** Chaque ecriture recue, dans l'ordre - y compris celles restees en file.
   * Sert a compter les tranches. */
  writes: RecordingRow[];
  goOffline(): void;
  /** Vide la file dans `rows`, dans l'ordre, en ne gardant que la derniere
   * version de chaque ligne - la coalescence de la vraie file. */
  goOnline(): void;
  /** Les notes que le compte detient, par started_iso. */
  liveNotes: Map<string, Array<{ atMs: number; text: string }>>;
  clearedNotes: string[];
}

export function fakeCaptureStore(seed: RecordingRow[] = []): FakeCaptureStore {
  const rows = new Map<string, RecordingRow>(seed.map((r) => [r.id, r]));
  const writes: RecordingRow[] = [];
  const liveNotes = new Map<string, Array<{ atMs: number; text: string }>>();
  const clearedNotes: string[] = [];
  let online = true;
  /** La file : au plus une entree par identifiant, comme jobKey le garantit. */
  const queued = new Map<string, RecordingRow>();

  const store: FakeCaptureStore = {
    rows,
    writes,
    liveNotes,
    clearedNotes,
    write(row) {
      writes.push({ ...row });
      if (online) rows.set(row.id, { ...row });
      else queued.set(row.id, { ...row });
    },
    pending() {
      return queued.size;
    },
    remove(id) {
      writes.push({ ...(rows.get(id) ?? queued.get(id) ?? ({ id } as RecordingRow)), doc: "" });
      rows.delete(id);
      queued.delete(id);
    },
    read(id) {
      // La file d'abord, comme le vrai magasin : hors ligne, elle est la seule a
      // connaitre la derniere version.
      return Promise.resolve(queued.get(id) ?? rows.get(id) ?? null);
    },
    listOpen() {
      const open: OpenRecording[] = [];
      for (const r of rows.values()) {
        if (r.endedIso) continue;
        // La ligne ENTIERE, comme le vrai depot : rien de ce qu'elle porte ne
        // doit se perdre en la fermant. Le vrai pouls est pousse cote base a
        // chaque ecriture ; ici on prend l'instant de depart, et les tests qui
        // ont besoin d'un pouls precis ensemencent la ligne eux-memes.
        open.push({ ...r, heartbeatIso: r.startedIso });
      }
      return Promise.resolve(open);
    },
    readLiveNotes(startedIso) {
      return Promise.resolve(liveNotes.get(startedIso) ?? []);
    },
    clearLiveNotes(startedIso) {
      clearedNotes.push(startedIso);
      liveNotes.delete(startedIso);
    },
    goOffline() {
      online = false;
    },
    goOnline() {
      online = true;
      for (const [id, row] of queued) rows.set(id, row);
      queued.clear();
    },
  };
  return store;
}
