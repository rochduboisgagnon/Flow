import React, { useState } from "react";
import type { UiStatePayload } from "../../shared/ipcContracts";
import { Row } from "./components";
import iconUrl from "../assets/icon.png";

// ---------------------------------------------------------------------------
// LE FORMULAIRE DE CONNEXION, UNE SEULE FOIS.
//
// Il vivait dans l'onglet Account de Reglages. B4 en a eu besoin AU LANCEMENT,
// sur tout l'ecran, et le recopier aurait produit deux formulaires qui divergent
// - dont un seul se souviendrait, dans six mois, que le mot de passe doit
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

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState("");

  async function signIn(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy || signedIn) return;
    setBusy(true);
    setError("");
    let ok = false;
    try {
      const r = await window.flowui.signIn(email, password);
      ok = r.ok;
      if (!r.ok) setError(r.error || "Could not sign in.");
    } finally {
      // Dans le `finally` : le mot de passe s'efface meme quand ca a rate.
      setPassword("");
      // LE MOT DE PASSE QUI CLIGNOTE UNE SECONDE, ET POURQUOI CE N'EST PAS
      // COSMETIQUE.
      //
      // Roch, le 2026-08-04 : « apres avoir clique sur Enter, il y a comme un
      // mini bug graphique, le password disparait pendant comme une seconde,
      // puis ca me logged in ».
      //
      // Ce qu'il voyait etait exact, et c'etait CE `finally` : la connexion
      // reussit en ~200 ms, mais l'ecran ne disparait qu'une fois le compte
      // charge (reglages + dictionnaire + reunions, une seconde de reseau).
      // Entre les deux, le formulaire etait encore la, avec son champ de mot de
      // passe vide et son bouton revenu a « Sign in » : donc exactement l'image
      // d'une tentative qui vient d'echouer, juste avant d'entrer.
      //
      // La reparation N'EST PAS de garder le mot de passe a l'ecran - il doit
      // partir, y compris quand ca rate, c'est la decision du bandeau ci-dessus.
      // C'est de ne plus montrer un formulaire du tout des que la connexion est
      // acquise : le succes remplace les champs par la ligne d'attente, ce qui
      // se lit comme une PROGRESSION et non comme un retour a la case depart.
      setSignedIn(ok);
      if (!ok) setBusy(false);
    }
  }

  // Le succes, avant que l'ecran entier disparaisse. Meme phrase que la branche
  // « connecte, donnees pas encore la » de SignInScreen, parce que c'est le meme
  // etat : la session existe, le compte n'est pas encore descendu.
  if (signedIn) return <p className="gate-msg">Loading your account...</p>;

  // 2026-08-04, Roch : « rien d'ecrit ». Les deux phrases qui expliquaient sous
  // chaque champ qu'il n'y a pas d'inscription et que le mot de passe ne survit
  // pas repondaient a des questions que personne ne pose devant un formulaire de
  // connexion. Les DECISIONS, elles, sont intactes - elles vivent dans le bandeau
  // de ce fichier, ou elles servent a celui qui modifie le code plutot qu'a celui
  // qui tape son mot de passe.
  return (
    <form onSubmit={(e) => void signIn(e)}>
      <Row label="Email" help="">
        <input
          type="email"
          value={email}
          autoComplete="username"
          // Le premier champ du seul geste que cet ecran offre. Ce n'est pas du
          // confort : sans lui, il faut cliquer avant de pouvoir taper, sur un
          // ecran qui n'a rien d'autre a proposer.
          autoFocus
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
      <button className="btn gate-go" type="submit" disabled={busy || !email || !password}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
      {/* La hauteur de cette ligne est RESERVEE (.gate-msg) meme quand il n'y a
          rien a dire : sans ca, la carte grandit au moment ou une connexion
          echoue, donc le bouton descend sous le curseur de quelqu'un qui vient de
          rater son mot de passe et s'apprete a reessayer. `role="alert"` pour que
          l'echec soit annonce, et pas seulement affiche. */}
      <p className={"gate-msg" + (error ? " err" : "")} role="alert">
        {error}
      </p>
    </form>
  );
}

/**
 * L'ECRAN DE LANCEMENT : ce que la fenetre montre a la place de l'application.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI UNE PORTE, ET PAS UN ONGLET
 * ---------------------------------------------------------------------------
 *
 * Trouve en LANCANT l'application apres B3 : Flow demarrait, armait le raccourci,
 * chauffait le moteur - et laissait commencer une reunion que personne ne pourrait
 * relire, parce que sa ligne n'avait aucun compte ou aller. Le moteur refuse
 * maintenant sur ses cinq chemins (main/index.ts, refuseIfNoAccount), et cet
 * ecran est l'autre moitie : il dit POURQUOI avant qu'on essaie.
 *
 * App.tsx ne rend RIEN d'autre tant que le compte n'est pas charge - ni rail, ni
 * sections. Roch, le 2026-08-04 : « on ne devrait meme pas voir les menus ». Un
 * rail dont aucune section ne repond est un controle mort.
 *
 * ---------------------------------------------------------------------------
 * TROIS ETATS, ET AUCUN NE SE FAIT PASSER POUR UN AUTRE
 * ---------------------------------------------------------------------------
 *
 *  - PAS CONNECTE : le formulaire. Le cas normal d'un premier lancement.
 *  - CONNECTE, DONNEES PAS ENCORE LA : le seul cas ou une phrase est due -
 *    quelqu'un est connecte et l'ecran ne bouge pas, donc il doit savoir si Flow
 *    travaille ou s'il est bloque. Et surtout PAS le formulaire : le lui
 *    reafficher lui ferait retaper son mot de passe pour un probleme de reseau.
 *  - LE MOTEUR N'A PAS ENCORE PARLE : c'est App.tsx qui le montre, avant meme
 *    d'arriver ici.
 *
 * Ce qui n'est PAS ici : un bouton « continuer sans compte ». Il n'y a rien a
 * continuer - une dictee comme une reunion a besoin du dictionnaire et des
 * reglages du compte.
 */
export function SignInScreen({ s }: { s: UiStatePayload }) {
  // 2026-08-04 : `restoringSession` s'ajoute a la condition, et pour la meme
  // raison que le reste de cette branche - il y a une TROISIEME facon d'etre en
  // train d'entrer sans avoir a taper quoi que ce soit : Flow reprend la session
  // du trousseau. Montrer le formulaire pendant ce temps-la, c'est demander un mot
  // de passe a quelqu'un qui est deja reconnu.
  const loading = s.restoringSession || (s.account.signedIn && !s.accountDataReady);
  return (
    <div className="gate-card">
      {/* LE LOGO, PAS LE MOT. Roch, le 2026-08-04 : « ou c'est ecrit Flow, mais le
          logo de Flow a place ». Byte pour byte le meme fichier que la barre de
          titre (resources/icon.png, egalite verifiee au build), donc l'ecran
          d'entree et la fenetre portent la meme marque et non deux variantes.

          `alt=""` et `aria-hidden` : le nom du produit est deja dans la barre de
          titre et dans le titre de la fenetre, donc un lecteur d'ecran qui
          annoncerait « Flow » une troisieme fois ne dirait rien de neuf.

          LE RUBAN A DISPARU. Il etait la comme signature - la meme forme que
          l'indicateur « je t'entends » de la pastille - et mon raisonnement se
          tenait. Le RESULTAT, non : au repos et a cette taille, il se lisait comme
          un trait brun oublie sous le titre, c'est-a-dire comme une erreur. Une
          decoration qui a l'air d'un accident coute plus que rien du tout. */}
      <img className="gate-logo" src={iconUrl} alt="" aria-hidden="true" width={52} height={52} />
      {loading ? (
        <>
          {/* Le SEUL cas ou une phrase est due : quelqu'un est connecte et l'ecran
              ne bouge pas, donc il doit savoir si Flow travaille ou s'il est
              bloque. */}
          {/* L'adresse n'est connue qu'une fois la session reprise : pendant la
              reprise, la ligne serait vide. */}
          {s.account.email ? <p className="gate-who">{s.account.email}</p> : null}
          <p className="gate-msg">Loading your account...</p>
        </>
      ) : (
        <SignInForm />
      )}
    </div>
  );
}
