import { snapshotOf, type SupabaseClient } from "./client";
import type { SignInResult, AccountSnapshot } from "../../shared/ipcContracts";
import type { SessionStore } from "./sessionStore";

// ---------------------------------------------------------------------------
// A2 : s'inscrire, se connecter, se deconnecter.
//
// Ce module ne connait pas Supabase - il recoit un client deja construit. C'est
// ce qui le rend testable sans reseau, et ce qui garde la regle d'A3 intacte :
// un seul fichier importe la bibliotheque, et c'est client.ts.
//
// ---------------------------------------------------------------------------
// IL N'Y A PAS D'INSCRIPTION. C'EST LE POINT CENTRAL DE CE FICHIER.
// ---------------------------------------------------------------------------
//
// Decision de Roch, 2026-08-03 : personne ne cree son compte. Roch cree les
// comptes lui-meme, un par un, depuis la console Supabase ; s'il veut donner
// acces a quelqu'un, il lui fabrique son compte. Flow n'a donc qu'un ecran de
// connexion, et ce module qu'un seul verbe d'entree.
//
// CE QUE CA VEUT DIRE POUR LE CODE, et pourquoi il n'y a pas de `signUp` ici
// meme « au cas ou » : une fonction d'inscription sans appelant est une porte
// fermee mais pas verrouillee. Elle survit aux refactorisations, elle se
// rebranche en une ligne, et le jour ou elle se rebranche personne ne se
// demande si c'etait voulu. La regle est tenue a DEUX endroits qui ne peuvent
// pas deriver l'un de l'autre : ce fichier n'expose pas le verbe, et le projet
// Supabase refuse les inscriptions cote serveur. Le second est celui qui
// compte - la clef publiable part dans l'installeur, donc n'importe qui peut
// poster vers /auth/v1/signup sans passer par notre interface.
//
// ---------------------------------------------------------------------------
// CE QUI NE SORT JAMAIS D'ICI
// ---------------------------------------------------------------------------
//
// Aucune fonction de ce fichier ne rend un jeton, et aucune n'en journalise un.
// Tout ce qui remonte passe par `AccountSnapshot`, qui porte trois champs et
// aucun d'eux n'ouvre le compte. Ce n'est pas de la prudence de facade :
// c'est la regression numero 6 que le plan demande de chercher, et elle
// n'arrive jamais par malveillance - elle arrive parce qu'on passe l'objet
// Session complet a une page pour en afficher le courriel.
// ---------------------------------------------------------------------------

export interface AuthDeps {
  client: SupabaseClient;
  /** Le magasin du jeton. `clear()` est appele a la deconnexion, en plus de
   * celle du client : voir signOut. */
  store: Pick<SessionStore, "clear">;
  log?(msg: string): void;
}

/** Traduit une erreur Supabase en une phrase montrable, sans jamais recopier
 * un identifiant ni un jeton. */
function readable(err: { message?: string } | null): string {
  const m = err?.message?.trim();
  if (!m) return "";
  // Les deux seuls cas ou le message brut est plus deroutant qu'utile.
  if (/email not confirmed/i.test(m)) {
    return "Ce compte existe mais son adresse n'a pas encore ete confirmee. Le lien est dans le courriel d'inscription.";
  }
  if (/invalid login credentials/i.test(m)) {
    return "Adresse ou mot de passe incorrect.";
  }
  return m;
}

export type { SignInResult, AccountSnapshot };

export class Auth {
  private deps: AuthDeps;

  constructor(deps: AuthDeps) {
    this.deps = deps;
  }

  /** L'etat courant, lu depuis la session que le client detient deja.
   *
   * Ne declenche AUCUN appel reseau : c'est la fonction que la poussee d'etat a
   * 1 Hz appelle, et une requete par seconde vers Supabase pour afficher une
   * adresse courriel serait absurde. */
  async account(): Promise<AccountSnapshot> {
    const { data } = await this.deps.client.auth.getSession();
    return snapshotOf(data.session ?? null);
  }

  /** Previent a chaque changement de session : connexion, deconnexion, et - le
   * cas qu'on oublie - RAFRAICHISSEMENT AUTOMATIQUE du jeton, toutes les
   * heures.
   *
   * Ecoute plutot que sondage, delibere. La poussee d'etat de Flow tourne a
   * 1 Hz : demander « qui est connecte ? » a cette cadence ferait une promesse
   * par seconde pour une valeur qui change trois fois par jour. Ici, main
   * garde une copie et ne la met a jour que lorsqu'elle bouge vraiment. */
  onChange(cb: (account: AccountSnapshot) => void): void {
    this.deps.client.auth.onAuthStateChange((_event, session) => {
      cb(snapshotOf(session ?? null));
    });
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    const { data, error } = await this.deps.client.auth.signInWithPassword({ email, password });
    if (error) {
      // L'adresse n'est pas journalisee : un journal est ce qu'on colle dans un
      // rapport de bogue, et l'adresse d'un compte n'a rien a y faire.
      this.deps.log?.("[auth] connexion refusee");
      return { ok: false, error: readable(error), account: snapshotOf(null) };
    }
    this.deps.log?.("[auth] connecte");
    return { ok: true, error: "", account: snapshotOf(data.session) };
  }

  /**
   * Se deconnecter.
   *
   * DEUX EFFACEMENTS, ET LE SECOND N'EST PAS DE LA CEINTURE ET BRETELLES. Le
   * client efface sa session par notre magasin, ce qui suffit dans le cas
   * normal ; mais `signOut` commence par un appel RESEAU, et un appel reseau
   * echoue. Sans le `store.clear()` qui suit, une deconnexion demandee hors
   * ligne laisserait le jeton sur le disque tout en affichant « deconnecte » :
   * exactement le contraire de ce que l'utilisateur vient de demander, et le
   * genre de panne que personne ne remarque avant qu'elle compte.
   *
   * `scope` : "local" ne revoque que CET appareil - c'est la revocation par
   * appareil que le plan demande. "global" ferme les sessions partout, ce qu'on
   * veut quand on croit s'etre fait voler une machine.
   */
  async signOut(scope: "local" | "global" = "local"): Promise<{ ok: boolean; error: string }> {
    let error = "";
    try {
      const res = await this.deps.client.auth.signOut({ scope });
      if (res.error) error = readable(res.error);
    } catch (err) {
      error = (err as Error).message;
    }
    // TOUJOURS, meme quand l'appel ci-dessus a echoue.
    this.deps.store.clear();
    if (error) {
      this.deps.log?.(`[auth] deconnexion locale faite ; le serveur n'a pas repondu (${error})`);
      // ok reste VRAI : sur cette machine, le jeton est parti. Rendre false
      // pousserait l'interface a proposer de reessayer une chose deja faite.
      return { ok: true, error };
    }
    this.deps.log?.("[auth] deconnecte");
    return { ok: true, error: "" };
  }
}
