import { randomUUID } from "node:crypto";
import {
  applyNoteAdd,
  applyNoteDelete,
  applyNoteEdit,
  type LiveNote,
  type LiveNotesResult,
} from "../shared/liveNotes";

// D7: the store behind the live notes panel. MIRROR of main/snippets.ts - atomic
// tmp+rename write, tolerant read, version guard, and a refusal to overwrite a
// file this build did not understand. Read that module's note for the reasoning;
// everything below is the same discipline, plus the three things that are
// specific to this store.
//
// ---------------------------------------------------------------------------
// WHERE THE FILE LIVES, AND WHY NOT IN THE RECORDING'S OWN FOLDER
// ---------------------------------------------------------------------------
// The obvious home for these notes is beside the document they will end up in,
// in the recording's folder. It was rejected: that folder MOVES. A staged
// recording is relocated into the dated archive by fileIntoHistory(), and again
// into a folder of the user's choosing by save(), and both of those move exactly
// two files - the .md and the .wav - by name. A third file in there would be
// left behind on the first move, in a staging folder nothing lists and the
// retention purge eventually deletes: the user's own notes, gone, silently.
// Teaching three move paths, a rollback and a boot rescan about a fourth file is
// precisely the "two places to keep right" that V4's review lists as a risk.
//
// So the slot lives at <dataDir>/live-notes.json, outside every folder that
// moves, and the notes travel into the document ONCE, at the end, by being
// written into it. After that the slot is cleared and there is nothing left to
// keep in step with anything.
//
// ---------------------------------------------------------------------------
// ONE SLOT, NAMED BY THE RECORDING
// ---------------------------------------------------------------------------
// LongRecorder.start() refuses to start a second recording while one is running,
// so there is never more than one live recording on this machine - one slot is
// enough, and there is no id for a caller to forge or guess.
//
// Every operation still NAMES the recording it believes it is writing for
// (startedIso, the recorder's own start instant), and a mismatch is REFUSED
// rather than reconciled. That is what makes it impossible for notes typed
// during one meeting to be attached to the next: not a convention, a check.
//
// ---------------------------------------------------------------------------
// A SLOT IS NEVER SILENTLY DISCARDED
// ---------------------------------------------------------------------------
// open() is called at the start of every recording, and it may find notes
// belonging to a DIFFERENT one. That means an earlier session's notes were never
// merged into their document - the session died in a way none of the three merge
// paths caught. Overwriting them would be a silent loss of the one thing in this
// app a machine cannot reproduce, so they are moved aside to a dated file and the
// log says exactly where they went. Nothing in Flow reads that file again; it
// exists so the answer to "where did my notes go" is never "nowhere".

/** What a caller gets when the store refuses outright. Shaped like every real
 * answer, so a page never has to tell "refused" apart from "genuinely empty" -
 * two states that look identical in a naive length check and mean the opposite
 * (main/snippets.ts's SNIPPETS_UNAVAILABLE, same reasoning). */
export const LIVE_NOTES_UNAVAILABLE: LiveNotesResult = {
  ok: false,
  startedIso: "",
  notes: [],
  error: "unavailable",
};

// B2 : `liveNotesPath`, `loadLiveNotesFile` et `writeLiveNotesFile` ont disparu
// avec live-notes.json. Elles portaient l'ecriture atomique, la garde de
// version et le refus de reecrire un fichier mal compris - trois protections
// d'un support qui n'existe plus. Les fonctions PURES de shared/liveNotes.ts
// (applyNoteAdd, applyNoteEdit, applyNoteDelete) restent : elles decrivent ce
// qu'est une note, pas ou elle vit.

// ---------------------------------------------------------------------------
// B2, dernier magasin : live-notes.json disparait.
//
// CE QUE CE MODULE PROTEGE, ET POURQUOI IL EST LE DERNIER : les notes tapees
// pendant une reunion sont la SEULE partie d'une capture qu'on ne peut pas
// regenerer. Le transcript se refait depuis l'audio ; ce que quelqu'un a pris
// la peine d'ecrire pendant qu'on lui parlait, non.
//
// LE MODELE CHANGE, ET C'EST UNE AMELIORATION. Le fichier etait un SLOT unique :
// une seule fente, un seul enregistrement a la fois, et tout le ceremonial
// autour - deplacer des notes etrangeres de cote, refuser d'ecrire par-dessus
// un fichier qu'on n'a pas compris - existait parce que deux enregistrements
// devaient se partager une seule fente. La table `live_notes` a une colonne
// `started_iso` : chaque enregistrement a la sienne, et la question « a qui
// sont ces notes » ne se pose plus.
//
// CE QUI RESTE INCHANGE, PARCE QUE CE SONT DES PROMESSES ET PAS DES DETAILS DE
// SUPPORT :
//
//  - la page declare a chaque ecriture l'enregistrement qu'elle croit annoter,
//    et une note visant un enregistrement deja classe est REFUSEE plutot que de
//    tomber sur le suivant.
//  - `clear()` n'est appele qu'apres que les notes sont surement dans le
//    document. Effacer avant serait la seule erreur irrattrapable de ce module.
//  - le magasin ne lit JAMAIS l'horloge : `atMs` vient de l'appelant, calcule
//    depuis l'instant de depart du recorder, pour que l'estampille et la ligne
//    du temps ne viennent pas de deux endroits differents.
// ---------------------------------------------------------------------------

export interface LiveNotesBacking {
  /** Ecritures en arriere-plan : la frappe ne doit jamais attendre le reseau. */
  upsertLiveNote(startedIso: string, n: LiveNote): void;
  deleteLiveNote(id: string): void;
  clearLiveNotes(startedIso: string): void;
}

export interface LiveNotesStoreDeps {
  log?: (msg: string) => void;
  backing?(): LiveNotesBacking | null;
}

/**
 * The live-notes slot. Holds NO state of its own: every operation re-loads the
 * file, so fixing a broken one restores writes without restarting the app (the
 * property main/snippets.ts spells out), and so a slot cleared by a finalize
 * running between two of the page's calls is seen immediately.
 */
export class LiveNotesStore {
  private deps: LiveNotesStoreDeps;
  /** L'enregistrement en cours, et ses notes. En memoire : c'est ce que la page
   * relit dix fois par minute pendant une reunion, et la source de verite
   * pendant la seance. Le compte recoit chaque changement derriere. */
  private startedIso = "";
  private notes: LiveNote[] = [];

  constructor(deps: LiveNotesStoreDeps = {}) {
    this.deps = deps;
  }

  private backing(): LiveNotesBacking | null {
    return this.deps.backing?.() ?? null;
  }

  /** Appele par le recorder au start(). Rebranche la fente sur CET
   * enregistrement.
   *
   * Le ceremonial de mise a l'ecart des notes etrangeres a disparu avec le
   * fichier : chaque enregistrement a desormais sa propre ligne dans
   * `live_notes`, donc il n'y a plus de fente a se disputer. Des notes d'une
   * seance precedente qui n'ont jamais ete classees restent simplement dans le
   * compte, sous leur propre `started_iso`. */
  open(startedIso: string): void {
    const iso = (startedIso || "").trim();
    if (!iso || iso === this.startedIso) return;
    this.startedIso = iso;
    this.notes = [];
  }

  list(): LiveNotesResult {
    return { ok: true, startedIso: this.startedIso, notes: [...this.notes] };
  }

  add(startedIso: string, rawText: unknown, atMs: number): LiveNotesResult {
    return this.mutate(startedIso, (notes) => applyNoteAdd(notes, rawText, atMs, randomUUID()));
  }

  edit(startedIso: string, rawId: unknown, rawText: unknown): LiveNotesResult {
    return this.mutate(startedIso, (notes) => applyNoteEdit(notes, rawId, rawText));
  }

  remove(startedIso: string, rawId: unknown): LiveNotesResult {
    return this.mutate(startedIso, (notes) => ({ notes: applyNoteDelete(notes, rawId) }));
  }

  /** Ce que le recorder lit a la fin. Vide - jamais les notes d'un AUTRE
   * enregistrement - quand la fente en nomme un different. */
  read(startedIso: string): LiveNote[] {
    const iso = (startedIso || "").trim();
    if (!iso || iso !== this.startedIso) return [];
    return [...this.notes];
  }

  /** UNIQUEMENT apres que les notes sont surement dans le document. Si
   * l'ecriture du document a echoue, la fente est laissee telle quelle : les
   * notes restent dans le compte sous leur `started_iso`, ce qui est
   * rattrapable. Effacer d'abord ne le serait pas. */
  clear(startedIso: string): void {
    const iso = (startedIso || "").trim();
    if (iso && iso !== this.startedIso) return;
    this.backing()?.clearLiveNotes(this.startedIso);
    this.notes = [];
    this.startedIso = "";
  }

  private mutate(
    startedIso: string,
    apply: (notes: readonly LiveNote[]) => { notes: LiveNote[] } | { error: string },
  ): LiveNotesResult {
    const iso = (startedIso || "").trim();
    // Pas d'enregistrement, ou un autre que celui que l'appelant croit : on
    // REFUSE. Une page qui a course avec la fin d'un enregistrement doit
    // l'apprendre, pas voir sa note classee sur la seance suivante.
    if (!iso || iso !== this.startedIso) {
      return {
        ok: false,
        startedIso: this.startedIso,
        notes: [...this.notes],
        error: "cette note vise un enregistrement qui n'est plus celui en cours",
      };
    }
    const applied = apply(this.notes);
    if ("error" in applied) {
      return { ok: false, startedIso: this.startedIso, notes: [...this.notes], error: applied.error };
    }
    const before = new Map(this.notes.map((n) => [n.id, JSON.stringify(n)]));
    this.notes = applied.notes;
    const b = this.backing();
    if (b) {
      const after = new Set(this.notes.map((n) => n.id));
      for (const n of this.notes) {
        if (before.get(n.id) !== JSON.stringify(n)) b.upsertLiveNote(this.startedIso, n);
      }
      for (const id of before.keys()) {
        if (!after.has(id)) b.deleteLiveNote(id);
      }
    }
    return { ok: true, startedIso: this.startedIso, notes: [...this.notes] };
  }
}
