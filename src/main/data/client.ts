import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";
import { supabaseUrl, supabaseAnonKey } from "../../shared/supabaseConfig";
import type { SupabaseStorage } from "./sessionStore";

// ---------------------------------------------------------------------------
// A3 : LE SEUL FICHIER DE FLOW QUI IMPORTE `@supabase/supabase-js`.
//
// C'est la regle du plan, et test/supabase-dep.test.ts la tient. Elle n'est pas
// esthetique : quand toute lecture et toute ecriture passe par un point unique,
// une question comme « est-ce qu'une ecriture peut bloquer le chemin chaud de
// la dictee ? » a UN endroit ou se verifier. Repandue sur douze fichiers, la
// meme question ne se verifie plus, elle se croit.
//
// ---------------------------------------------------------------------------
// TROIS OPTIONS QUI COMPTENT, ET POURQUOI
// ---------------------------------------------------------------------------
//
// `detectSessionInUrl: false` - le client est ecrit d'abord pour un navigateur,
// ou il lit le fragment de l'URL apres une redirection OAuth. Ici, il n'y a pas
// d'URL. Laisser l'option par defaut ferait chercher un `window.location` qui
// n'existe pas dans le processus principal.
//
// `persistSession: true` avec NOTRE stockage - celui de sessionStore.ts, adosse
// au trousseau du systeme. Le defaut du client est `localStorage`, absent ici,
// et son repli est la memoire : la session serait perdue a chaque fermeture.
//
// `autoRefreshToken: true` - un jeton d'acces dure une heure. Sans ca, Flow
// marcherait une heure puis repondrait « non autorise » sur tout, ce qui se
// diagnostique tres mal parce que ca ressemble a une panne reseau.
// ---------------------------------------------------------------------------

/** Re-exporte, pour que la regle « un seul fichier importe la bibliotheque »
 * reste ABSOLUE plutot que de gagner une clause « sauf les types ».
 *
 * Un import de type ne cree aucune dependance a l'execution, donc l'exception
 * serait defendable - et c'est precisement le probleme : une regle avec une
 * exception defendable se plaide, et la porte qui la tient devient une porte
 * qu'on discute. Une ligne de re-export coute moins cher que ce debat. */
export type { SupabaseClient, Session } from "@supabase/supabase-js";

export interface FlowClientDeps {
  storage: SupabaseStorage;
  /** Injectable pour les tests, et pour pointer un projet de test. */
  url?: string;
  anonKey?: string;
}

export function createFlowClient(deps: FlowClientDeps): SupabaseClient {
  return createClient(deps.url ?? supabaseUrl(), deps.anonKey ?? supabaseAnonKey(), {
    auth: {
      storage: deps.storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      // Une seule cle de stockage, nommee, plutot que celle derivee de l'URL du
      // projet : le jour ou le projet change, la session precedente doit etre
      // trouvee et remplacee, pas oubliee a cote sous un autre nom.
      storageKey: "flow-session",
    },
    global: {
      headers: { "x-flow-client": "flow-desktop" },
    },
  });
}

/** Ce que le reste de l'application a le droit de savoir d'une session.
 *
 * DELIBEREMENT SANS LES JETONS. C'est la fuite numero 6 de la liste des
 * regressions du plan, et elle n'arrive jamais par malveillance : elle arrive
 * parce qu'un jour quelqu'un passe l'objet `Session` complet a une page, ou a
 * `/status`, ou a `selfCheck()`, pour en afficher le courriel. Le type ci-
 * dessous rend ce geste impossible sans le remarquer. */
export interface AccountSnapshot {
  signedIn: boolean;
  /** Vide tant que personne n'est connecte. */
  email: string;
  /** L'identifiant du compte : c'est LUI qui prefixe les objets audio dans
   * Storage, donc il est utile ailleurs. Il n'ouvre rien tout seul. */
  userId: string;
}

/** La seule facon de transformer une Session en quelque chose de montrable.
 *
 * Un mot sur ce qui n'est pas la : `access_token`, `refresh_token`,
 * `provider_token` et `expires_at`. Les trois premiers ouvrent le compte. Le
 * quatrieme ne l'ouvre pas mais n'a aucun appelant, et un champ sans appelant
 * dans une frontiere est une invitation a la traverser. */
export function snapshotOf(session: Session | null): AccountSnapshot {
  if (!session?.user) return { signedIn: false, email: "", userId: "" };
  return {
    signedIn: true,
    email: typeof session.user.email === "string" ? session.user.email : "",
    userId: session.user.id,
  };
}
