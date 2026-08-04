import React, { useState } from "react";
import type { UiStatePayload } from "../../shared/ipcContracts";
import { Row } from "./components";

// ---------------------------------------------------------------------------
// B4 : LE FORMULAIRE DE CONNEXION, UNE SEULE FOIS.
//
// Il vivait dans l'onglet Account de Reglages. B4 en a besoin AU LANCEMENT, sur
// tout l'ecran, et le recopier aurait produit deux formulaires qui divergent -
// dont un seul se souviendrait, dans six mois, que le mot de passe doit
// disparaitre du champ meme quand la connexion echoue.
//
// ---------------------------------------------------------------------------
// IL N'Y A PAS D'INSCRIPTION, ET CE N'EST PAS UNE OMISSION
// ---------------------------------------------------------------------------
//
// Les comptes sont crees dans la console Supabase. Le projet REFUSE les
// inscriptions cote serveur (`422 signup_disabled`, verifie), et c'est la moitie
// qui compte : la clef publiable part dans l'installeur, donc une porte fermee
// seulement dans cette page ne serait pas fermee du tout.
//
// ---------------------------------------------------------------------------
// LE MOT DE PASSE NE SURVIT PAS A LA SOUMISSION
// ---------------------------------------------------------------------------
//
// Il vit dans l'etat de ce composant le temps de la frappe, part UNE fois vers le
// processus principal, et le champ est vide immediatement apres - y compris quand
// la connexion echoue, parce que c'est le cas ou on est tente de le laisser « pour
// reessayer ». Un mot de passe qui reste dans un champ est un mot de passe visible
// par-dessus l'epaule.
// ---------------------------------------------------------------------------

export function SignInForm({ onDone }: { onDone?: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await window.flowui.signIn(email, password);
      if (!r.ok) setError(r.error || "Could not sign in.");
      else onDone?.();
    } finally {
      // Dans le `finally` : le mot de passe s'efface meme quand ca a rate.
      setPassword("");
      setBusy(false);
    }
  }

  // 2026-08-04, Roch : « rien d'ecrit ». Les deux phrases qui expliquaient sous
  // chaque champ qu'il n'y a pas d'inscription et que le mot de passe ne survit
  // pas repondaient a des questions que personne ne pose devant un formulaire de
  // connexion. Les DECISIONS, elles, sont intactes - elles vivent dans le bandeau
  // de ce fichier, ou elles servent a celui qui modifie le code plutot qu'a celui
  // qui tape son mot de passe.
  return (
    <form className="rows" onSubmit={(e) => void signIn(e)}>
      <Row label="Email" help="">
        <input
          type="email"
          value={email}
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email"
        />
      </Row>
      <Row label="Password" help="">
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
        />
      </Row>
      <Row label="" help="">
        <button className="btn" type="submit" disabled={busy || !email || !password}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </Row>
      {error ? <p className="sub">{error}</p> : null}
    </form>
  );
}

/**
 * L'ECRAN DE LANCEMENT : ce que la fenetre montre a la place de l'application.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI UNE PORTE, ET PAS SEULEMENT UN ONGLET
 * ---------------------------------------------------------------------------
 *
 * Trouve en LANCANT l'application apres B3 : Flow demarrait, armait le raccourci,
 * chauffait le moteur - et laissait commencer une reunion que personne ne pourrait
 * relire, parce que sa ligne n'avait aucun compte ou aller. Le moteur la refuse
 * maintenant (main/index.ts, refuseIfNoAccount), et cet ecran est l'autre moitie :
 * il dit POURQUOI avant qu'on essaie, au lieu de laisser quelqu'un decouvrir le
 * refus au moment ou la reunion commence.
 *
 * ---------------------------------------------------------------------------
 * TROIS ETATS, ET AUCUN NE SE FAIT PASSER POUR UN AUTRE
 * ---------------------------------------------------------------------------
 *
 *  - PAS CONNECTE : le formulaire. C'est le cas normal d'un premier lancement.
 *  - CONNECTE, DONNEES PAS ENCORE LA : « chargement », et la raison probable.
 *    C'est le cas d'un lancement hors ligne, et il ne doit surtout pas
 *    ressembler au precedent - reafficher un formulaire a quelqu'un qui est deja
 *    connecte lui ferait retaper son mot de passe pour un probleme de reseau.
 *  - LE MOTEUR N'A PAS ENCORE PARLE : c'est App.tsx qui le montre, avant meme
 *    d'arriver ici.
 *
 * Ce qui n'est PAS ici : un bouton « continuer sans compte ». Il n'y a rien a
 * continuer - une dictee comme une reunion a besoin du dictionnaire et des
 * reglages du compte.
 */
export function SignInScreen({ s }: { s: UiStatePayload }) {
  const loading = s.account.signedIn && !s.accountDataReady;
  return (
    <div className="gate-card">
      <h1 className="gate-title">Flow</h1>
      {loading ? (
        // Le seul cas ou une phrase est due : quelqu'un est connecte et l'ecran
        // ne bouge pas. Sans elle, il ne saurait pas si Flow travaille ou s'il
        // est bloque.
        <p className="sub">Signed in as {s.account.email}. Loading your account...</p>
      ) : (
        <SignInForm />
      )}
    </div>
  );
}
