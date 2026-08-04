// ---------------------------------------------------------------------------
// 2026-08-04 : LES NOTES SORTENT DANS LA LANGUE DU TRANSCRIPT, TITRES COMPRIS.
//
// Demande de Roch : « si le transcript est en francais, ca sort en francais ; si
// c'est en anglais, ca sort en anglais ; si c'est dans d'autres langues, ca sort
// dans les autres langues respectives. »
//
// ---------------------------------------------------------------------------
// CE QUE LA MESURE A TROUVE, ET QUI N'ETAIT PAS CE QUE LE TODO ANNONCAIT
// ---------------------------------------------------------------------------
//
// Le TODO portait « le resume d'un transcript francais sort en ANGLAIS » comme un
// plafond du modele 3B. Mesure du 2026-08-04, quatre executions contre le VRAI
// modele (Qwen2.5-3B-Instruct-Q4_K_M, llama-server, le meme prompt qu'en
// production) :
//
//   transcript francais + prompt actuel -> prose FRANCAISE, titres francais
//   transcript anglais  + prompt actuel -> prose ANGLAISE, titres FRANCAIS
//
// Donc la prose suivait deja la langue, et l'affirmation du TODO ne se reproduit
// pas. Le vrai defaut est ailleurs et il etait dans le prompt, pas dans le
// modele : les quatre titres de section y sont ECRITS EN DUR en francais
// (« ## Points cles », « ## Suivis »), juste apres une phrase qui demande d'ecrire
// dans la langue du transcript. Deux instructions qui se contredisent, et le
// modele obeissait aux deux : du texte anglais sous des titres francais.
//
// ---------------------------------------------------------------------------
// POURQUOI DEUX LANGUES NOMMEES, ET UN TROISIEME CHEMIN
// ---------------------------------------------------------------------------
//
// Le francais et l'anglais sont nommes parce que ce sont les deux que le reglage
// de langue de Flow propose, les deux que Roch utilise, et les deux dont je peux
// verifier la traduction des titres. Une troisieme langue ecrite au hasard serait
// une devinette presentee comme un fait.
//
// Pour tout le reste, le prompt ne nomme rien et demande au modele d'ecrire les
// titres dans la langue du transcript, en donnant leur SENS en anglais. C'est
// moins fort qu'une consigne nommee, et c'est dit tel quel plutot que promis.
//
// ---------------------------------------------------------------------------
// LA DETECTION LIT LE TEXTE, ET NON LE REGLAGE
// ---------------------------------------------------------------------------
//
// `settings.language` aurait ete plus simple, et faux dans deux cas qui arrivent :
// il vaut « auto » par defaut sur une machine neuve, et un fichier IMPORTE n'a
// aucun rapport avec le reglage de dictee de celui qui l'importe. Le transcript,
// lui, est la seule chose qui dise la verite sur sa propre langue.
// ---------------------------------------------------------------------------

/** Les langues que le prompt peut NOMMER. Voir le bandeau sur pourquoi la liste
 * s'arrete a deux plutot que d'en deviner d'autres. */
export type SummaryLanguage = "fr" | "en";

/** Mots outils frequents, choisis pour ne PAS etre ambigus entre les deux
 * langues. Volontairement sans « on » (francais et anglais), sans « a »
 * (anglais / « a » francais sans accent), et sans « est » (« east »). */
const FR_WORDS = [
  "le", "la", "les", "des", "du", "une", "et", "que", "qui", "pas", "pour", "dans",
  "sur", "avec", "nous", "vous", "je", "il", "elle", "ce", "cette", "aux", "plus",
  "ca", "mais", "donc", "alors", "tout", "faire", "etre", "ete", "sont", "comme",
  "bien", "aussi", "leur", "notre", "votre", "chose", "peut", "veut", "deja",
];

const EN_WORDS = [
  "the", "and", "is", "are", "that", "this", "to", "of", "for", "in", "with",
  "we", "you", "it", "he", "she", "at", "be", "have", "has", "not", "from",
  "will", "was", "were", "they", "there", "would", "should", "about", "what",
  "which", "them", "their", "our", "your", "just", "also", "because", "going",
];

/** Le minimum de signaux avant de se prononcer. Une ligne de trois mots ne
 * decide pas de la langue d'un document. */
const MIN_HITS = 8;

/** L'ecart exige entre les deux camps. Un transcript bilingue - une reunion ou
 * deux personnes changent de langue - doit tomber dans « je ne sais pas » plutot
 * que d'etre tranche a une voix pres. */
const MIN_RATIO = 1.6;

/** Compte les occurrences de ces mots, sur des frontieres de mot. */
function hits(haystack: string, words: readonly string[]): number {
  let n = 0;
  for (const w of words) {
    const re = new RegExp(`(?:^|[^a-z])${w}(?:$|[^a-z])`, "g");
    // Un COMPTE, pas les correspondances : les frontieres se chevauchent (« de la »
    // partage l'espace), et un compte trop bas ne fait qu'hesiter la detection -
    // ce qui est le bon cote sur lequel se tromper.
    n += [...haystack.matchAll(re)].length;
  }
  return n;
}

/** Le texte parlé, sans les horodatages ni l'entete du document : ils sont
 * identiques dans toutes les langues et ne font que diluer le signal. */
export function spokenTextOnly(transcript: string): string {
  return String(transcript)
    .replace(/^\s*#.*$/gm, "") // titres markdown
    .replace(/^\s*-\s+(?:recorded|engine):.*$/gim, "") // l'entete du document
    .replace(/\[\d{2}:\d{2}:\d{2}\]/g, "") // les horodatages
    .replace(/^\s*>.*$/gm, "") // les citations (suggestions du modele)
    .toLowerCase();
}

/**
 * La langue du transcript, ou `null` quand il n'y a pas de quoi trancher.
 *
 * `null` n'est pas un echec : c'est le cas d'un transcript trop court, d'une
 * langue que cette fonction ne connait pas, ou d'une reunion bilingue. Le prompt
 * a un chemin pour ca, et il vaut mieux que d'affirmer une langue au hasard.
 */
export function detectSummaryLanguage(transcript: string): SummaryLanguage | null {
  const text = spokenTextOnly(transcript);
  if (!text.trim()) return null;
  const fr = hits(text, FR_WORDS);
  const en = hits(text, EN_WORDS);
  // Les diacritiques comptent, mais PEU : un transcript francais dicte sans
  // accents existe (le moteur en produit quand la langue n'est pas forcee), donc
  // leur absence ne doit rien prouver. Leur presence, elle, est un signal sur.
  const accents = (text.match(/[éèêëàâäîïôöùûüçœæ]/g) ?? []).length;
  const frScore = fr + Math.min(accents, 20);
  if (Math.max(frScore, en) < MIN_HITS) return null;
  if (frScore >= en * MIN_RATIO) return "fr";
  if (en >= frScore * MIN_RATIO) return "en";
  return null;
}

/** Les quatre titres de section, par langue. Ce que le prompt ecrivait en dur
 * en francais quoi qu'il arrive. */
export const SUMMARY_HEADINGS: Record<SummaryLanguage, { key: string; decisions: string; actions: string; follow: string }> = {
  // Accentues : c'est du contenu que quelqu'un lit, pas un nom de fichier.
  fr: { key: "Points clés", decisions: "Décisions", actions: "Actions", follow: "Suivis" },
  en: { key: "Key points", decisions: "Decisions", actions: "Actions", follow: "Follow-ups" },
};

/** Le nom de la langue, tel que l'instruction (en anglais) doit la nommer. */
const LANGUAGE_NAME: Record<SummaryLanguage, string> = { fr: "FRENCH", en: "ENGLISH" };

/**
 * LA PARTIE « FORME » DU PROMPT, dans la langue du transcript.
 *
 * Elle porte trois choses, et la premiere est celle qui a change : la langue est
 * NOMMEE quand on la connait, et les quatre titres sont dans cette langue. Le
 * reste - le paragraphe d'ouverture sans titre, les quatre sections - est celui
 * d'avant, mot pour mot.
 */
export function summaryShape(lang: SummaryLanguage | null): string {
  const H = lang ? SUMMARY_HEADINGS[lang] : null;
  const language = lang
    ? `LANGUAGE: the transcript is in ${LANGUAGE_NAME[lang]}. Write EVERY word of your answer in ${LANGUAGE_NAME[lang]} - the summary, the bullets AND the headings. Never translate the content into another language.`
    : "LANGUAGE: write EVERY word of your answer in the SAME language the transcript is written in - the summary, the bullets AND the headings, which you must translate into that language. Never translate the content into another language, and never fall back to English because the instructions are in English.";
  const headings = H
    ? `"## ${H.key}", "## ${H.decisions}", "## ${H.actions}" (name the owner and any stated deadline), and "## ${H.follow}" (include this section only if there are open follow-ups)`
    : '"## Key points", "## Decisions", "## Actions" (name the owner and any stated deadline), and "## Follow-ups" (include this section only if there are open follow-ups) - each of these four headings TRANSLATED into the language of the transcript';
  return [
    language,
    // 2026-08-04 : « NO heading of its own » etait deja la, et le modele ecrivait
    // quand meme « ## Summary » par-dessus - mesure. La consigne est donc
    // repetee ET la sortie est nettoyee apres coup (stripLeadingSummaryHeading) :
    // une regle qu'un modele peut ignorer se double d'une regle qui, elle, ne
    // s'ignore pas.
    "Start with a one-paragraph summary as plain text. That paragraph gets NO heading of its own: do not write \"## Summary\" or its translation above it.",
    `Then add these sections, each introduced by its exact heading alone on its line with bullet points beneath it: ${headings}.`,
  ].join(" ");
}

/** Les titres qu'un modele pose au-dessus du paragraphe d'ouverture malgre la
 * consigne. Mesures (« ## Summary ») ou attendus par symetrie. */
const LEADING_SUMMARY_HEADINGS = [
  "summary", "résumé", "resume", "sommaire", "synthèse", "synthese", "overview", "abstract",
];

/**
 * ENLEVE LE TITRE QUE LE PARAGRAPHE D'OUVERTURE NE DOIT PAS AVOIR.
 *
 * Le document enveloppe deja les notes sous « ## Notes » ; un « ## Summary »
 * juste en dessous empile deux titres dont le second ne dit rien de plus. Le
 * prompt l'interdit depuis longtemps, et la mesure du 2026-08-04 montre le modele
 * l'ecrire quand meme.
 *
 * Ne touche QUE la premiere ligne, et seulement si elle est un titre de cette
 * courte liste. « ## Points cles » en premiere ligne est une vraie section : elle
 * reste. Le reste du document n'est jamais lu ni modifie.
 */
export function stripLeadingSummaryHeading(notes: string): string {
  const text = String(notes);
  const m = /^\s*#{1,6}\s*([^\n]*?)\s*$/.exec(text.split("\n", 1)[0] ?? "");
  if (!m) return text;
  const title = m[1].toLowerCase().replace(/[:.]+$/, "").trim();
  if (!LEADING_SUMMARY_HEADINGS.includes(title)) return text;
  const nl = text.indexOf("\n");
  return nl === -1 ? "" : text.slice(nl + 1).replace(/^\s*\n/, "");
}
