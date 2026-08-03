// ---------------------------------------------------------------------------
// Z3 : les deux valeurs publiques, commitees, et l'explication de pourquoi
// c'est correct - parce que c'est la ligne que quelqu'un lira un jour en se
// demandant si une clef vient de fuiter dans un depot public.
//
// ELLES NE SONT PAS SECRETES, ET CE N'EST PAS UN ARRANGEMENT AVEC SOI-MEME.
// Elles partent dans l'installeur de toute facon : n'importe qui telecharge
// Flow, ouvre le paquet, et les lit. Les cacher dans une variable
// d'environnement ne ferait que deplacer l'endroit ou on les lit, tout en
// donnant l'impression d'un secret. Supabase les appelle d'ailleurs
// « publishable », ce qui est le mot juste.
//
// CE QUI PROTEGE VRAIMENT est ailleurs, et il faut le savoir en lisant ce
// fichier : la clef publiable dit « je suis l'application Flow ». Elle ne dit
// jamais « je suis Roch ». Ce qui distingue un compte d'un autre est le jeton
// de session, et ce qui transforme ce jeton en frontiere est le RLS de la
// premiere migration (supabase/migrations/20260803170000_flow_schema.sql).
// Quelqu'un qui prend cette clef obtient le droit de creer un compte. Rien de
// plus, et surtout aucune ligne de qui que ce soit.
//
// L'AUTRE CLEF, celle qui contourne le RLS, n'est ni ici ni nulle part dans ce
// depot : Supabase l'injecte lui-meme dans les Edge Functions sous
// SUPABASE_SERVICE_ROLE_KEY. test/no-service-key.test.ts echoue si elle
// reapparait dans un fichier suivi par git.
//
// L'ENVIRONNEMENT PEUT SURCHARGER, pour pointer un projet de test sans toucher
// au code. La valeur commitee reste celle qui part chez les gens : un
// installeur ne doit pas dependre de ce qui etait exporte dans le terminal de
// la machine de build.
// ---------------------------------------------------------------------------

/** Le projet Flow, region ca-central-1 (Toronto). */
const DEFAULT_URL = "https://hlryyzrpvyxcgwxjmjug.supabase.co";

/** Clef publiable. Voir le bandeau : publique par conception. */
const DEFAULT_ANON_KEY = "sb_publishable_ft_UGFAOBObfl4Wm4KYarQ_cHRwColH";

export function supabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUPABASE_URL?.trim() || DEFAULT_URL;
}

export function supabaseAnonKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUPABASE_ANON_KEY?.trim() || DEFAULT_ANON_KEY;
}
