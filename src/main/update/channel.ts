// ---------------------------------------------------------------------------
// 2026-08-04 : LA COUTURE ENTRE LA POLITIQUE DE MISE A JOUR ET SON MECANISME.
//
// Roch : « j'aimerais faire en sorte que l'app sur macOS se update sans devoir
// installer l'ancienne version ». Sur Windows, le mecanisme est electron-updater
// (il lit latest.yml, telecharge, echange l'installeur NSIS). Sur macOS ce
// mecanisme n'existe pas : Squirrel.Mac exige une signature Developer ID, et la
// decision de Roch est qu'aucun certificat ne sera achete.
//
// Il fallait donc DEUX mecanismes. Ce qu'il ne fallait surtout pas dupliquer,
// c'est la POLITIQUE : la cadence, la machine a phases que getUiState() et
// engineStatus() lisent, et surtout le sas calme - « un update n'installe JAMAIS
// pendant une dictee ou un enregistrement ». Deux copies de ce raisonnement
// divergeraient, et c'est exactement le mode de panne que le bandeau « the ONE
// definition of "busy" » (index.ts) combat depuis la revue A10.
//
// D'ou ce fichier : FlowUpdater garde la politique, le canal porte le mecanisme.
//
// IL NE CONTIENT QUE DES TYPES, ET N'IMPORTE RIEN. C'est ce qui permet a
// test/updater.test.ts d'exister : avant cette couture, updater.ts importait
// `electron` au niveau module, donc l'invariant central du fichier n'avait aucun
// test direct - seulement des canaris textuels qui prouvaient le cablage.
// ---------------------------------------------------------------------------

/** Ce qu'un mecanisme rapporte a la politique. Volontairement le meme jeu que
 * les evenements d'electron-updater : la couture suit la forme d'une des deux
 * implementations plutot que d'inventer une abstraction que personne ne remplit. */
export type ChannelEvent =
  | { kind: "checking" }
  | { kind: "not-available"; version: string }
  | { kind: "available"; version: string }
  | { kind: "progress"; pct: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

/** Le resultat d'une interrogation du feed.
 *
 * Un echec est une VALEUR et non une exception : le bouton « Check now » doit
 * pouvoir dire ce qui s'est passe, et un `throw` a travers deux couches finit
 * toujours par etre avale quelque part. */
export type CheckOutcome =
  | { ok: true; available: boolean; version: string }
  | { ok: false; message: string };

export interface UpdateChannel {
  /** Pour le journal, afin qu'une ligne de flow.log dise QUEL mecanisme a parle. */
  readonly kind: string;
  /** Arme une fois, par le constructeur de FlowUpdater. */
  onEvent(cb: (e: ChannelEvent) => void): void;
  /** Interroge le feed. Un telechargement peut demarrer tout seul derriere. */
  check(): Promise<CheckOutcome>;
  /** Echange le binaire et redemarre. Ne rend jamais la main normalement.
   *
   * C'est LE geste irreversible du chemin de mise a jour, et la seule chose que
   * le sas calme garde. FlowUpdater appelle stop() juste avant. */
  install(): void;
}
