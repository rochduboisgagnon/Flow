import type { Repo } from "./repo";
import type { WorkingCopy } from "./workingCopy";
import type { OpenRecording, RecordingRow } from "../../shared/recordings";
import type { CaptureStore } from "../longform";

// ---------------------------------------------------------------------------
// B3a : ce qui relie le recorder au compte.
//
// Une quinzaine de lignes, et c'est le point : le recorder pousse une ligne, la
// copie de travail la garde en memoire et l'envoie derriere, le depot parle a
// Supabase. Aucun des trois ne connait les deux autres.
//
// POURQUOI CET ADAPTATEUR EXISTE PLUTOT QUE DE PASSER `workingCopy` DIRECTEMENT.
// Deux raisons, et la deuxieme est la vraie :
//
//  1. `WorkingCopy` porte le dictionnaire, les statistiques et l'historique de
//     dictee. Un recorder qui la recevrait entiere pourrait effacer les
//     statistiques de quelqu'un par accident de frappe.
//  2. Les lectures. `read`, `listOpen` et `readLiveNotes` sont des allers-retours
//     reseau, et elles ne passent PAS par la copie de travail - une reunion n'est
//     pas chargee a la connexion (voir le bandeau de workingCopy.ts). Elles vont
//     donc droit au depot, et cette classe est l'endroit ou cette asymetrie est
//     visible d'un coup d'oeil au lieu d'etre repartie dans le recorder.
//
// AUCUNE de ces lectures n'est sur le chemin d'une capture : `read` sert a
// exporter, `listOpen` et `readLiveNotes` au sauvetage du lancement. Le seul
// verbe qu'une reunion en cours appelle est `write`, et il est synchrone.
// ---------------------------------------------------------------------------

export class WorkingCopyCaptureStore implements CaptureStore {
  private wc: WorkingCopy;
  private repo: Repo;

  constructor(deps: { workingCopy: WorkingCopy; repo: Repo }) {
    this.wc = deps.workingCopy;
    this.repo = deps.repo;
  }

  write(row: RecordingRow): void {
    this.wc.writeRecording(row);
  }

  pending(): number {
    return this.wc.pending();
  }

  remove(id: string): void {
    this.wc.deleteRecording(id);
  }

  async read(id: string): Promise<RecordingRow | null> {
    // La copie de travail d'abord : elle detient la ligne tant que l'envoi n'a
    // pas abouti, donc hors ligne elle est la SEULE a la connaitre. Demander au
    // reseau en premier rendrait l'export impossible exactement quand il rend
    // le plus de service.
    const held = this.wc.readRecording(id);
    if (held) return held;
    const r = await this.repo.readRecording(id);
    return r.ok ? r.data : null;
  }

  async listOpen(): Promise<OpenRecording[]> {
    const r = await this.repo.listOpenRecordings();
    return r.ok ? r.data : [];
  }

  async readLiveNotes(startedIso: string): Promise<Array<{ atMs: number; text: string }>> {
    const r = await this.repo.loadLiveNotes(startedIso);
    return r.ok ? r.data.map((n) => ({ atMs: n.at_ms, text: n.text })) : [];
  }

  clearLiveNotes(startedIso: string): void {
    this.wc.clearLiveNotes(startedIso);
  }
}
