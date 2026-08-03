// B2 : ni `fs`, ni `path`, ni `dataDir`. Ce module n'ecrit plus rien sur le
// disque de personne, et c'etait tout le point de la vague.
import { randomUUID } from "node:crypto";
import {
  applyDictionary,
  buildDictationPrompt,
  compileDictionary,
  phraseKey,
  type CompiledDictionary,
} from "../shared/dictionary";
import type { DictEntry, DictKind, DictResult } from "../shared/ipcContracts";

// U6a: the dictionary store. A deliberate MIRROR of main/snippets.ts - atomic
// tmp+rename write, tolerant read, a version guard that refuses to clobber a
// file this build does not understand, and a lossy load that freezes writes.
// Read that file's module note first: every promise made there is made here for
// the same reasons, and the two are meant to stay recognizably the same shape.
// What follows is only what is DIFFERENT about the dictionary.
//
// ---------------------------------------------------------------------------
// STILL NOT A FIELD IN settings.json
// ---------------------------------------------------------------------------
// Same argument as snippets, and it applies harder here. settings.json is
// rewritten WHOLE on every applySettings() - including from the dictation hot
// path - and sanitizeSettings() falls back to full defaults on a malformed
// byte. That is right for a dozen config fields with sane defaults and wrong
// for a vocabulary the user typed in by hand, one term at a time, over months.
// A separate ~/.flow/dictionary.json keeps the two failure domains apart.
//
// ---------------------------------------------------------------------------
// THE RUNTIME CACHE, AND WHY IT EXISTS
// ---------------------------------------------------------------------------
// Unlike snippets, this store is READ ON THE DICTATION PATH: every utterance
// needs the compiled replacement rules (storey 2) and every whisper request
// needs the prompt (storey 1). Doing that the way the snippet channels do -
// readFileSync + JSON.parse per operation - would put synchronous disk I/O on
// the process that carries the keyboard hook, once per dictation, forever.
//
// So the parsed entries, their compiled rule table and the composed prompt are
// cached at module level and REBUILT FROM THE ITEMS THE WRITE ALREADY HAS IN
// HAND (zero extra I/O) on every save and delete. primeDictionary() warms it
// once at boot. The lazy fallback in ensureCache() exists only so a boot
// ordering mistake degrades to one late read instead of silently disabling the
// feature.
//
// The cache is therefore authoritative for the whole run, which has one honest
// consequence worth naming: a dictionary.json edited by hand from OUTSIDE Flow
// is not picked up until the next list/save/delete or the next launch. That is
// the same deal every other cached thing in this app makes, and the file is
// still the source of truth - it is just read at known moments.

export const CURRENT_VERSION = 1 as const;

// Bounds, documented rather than guessed (same discipline as snippets.ts):
/** A term is a name, an acronym or a short phrase ("AGR Labs", "Loi 25"), never
 * a sentence. Also what bounds one term's share of the prompt budget. */
export const MAX_TERM_CHARS = 80;
/** An alias is a mis-hearing of the term, so it is the same order of size. */
export const MAX_ALIAS_CHARS = 80;
/** Ways the engine can get ONE word wrong. Past a couple of dozen, the entry is
 * not a term any more and the prompt/rule table stops being the right tool. */
export const MAX_ALIASES = 20;
/** A very large personal vocabulary. Matching cost does NOT grow with this
 * (shared/dictionary.ts's cost note), but the file is loaded and re-serialized
 * WHOLE on every write, and that does. */
export const MAX_ITEMS = 1000;
/** A minted id is a 36-char UUID; this only clamps a hand-edited one. */
export const MAX_ID_CHARS = 100;
/** How many individual losses a read-only message names before it counts the
 * rest - the message is read by a human, and a broken file yields one loss per
 * entry. */
export const MAX_REPORTED_LOSSES = 5;

export interface DictionaryFile {
  version: typeof CURRENT_VERSION;
  items: DictEntry[];
}

export interface ParsedDictionary {
  file: DictionaryFile;
  /** Set when the input could not be trusted, at the FILE level (wrong shape or
   * version - items is then empty, never a partial guess) or at the ITEM level
   * (an entry dropped, a field truncated, over MAX_ITEMS - items then holds what
   * we did understand). Either way it is the single predicate the overwrite
   * guard reads: we never write over a file we did not fully understand. */
  error?: string;
  /** ENOENT: there is no dictionary.json at all. Distinct from "an empty
   * library" because it is the ONE state that means "never seeded" - see
   * primeDictionary, and see why a user's deletion is never resurrected. */
  missing?: true;
}

interface StoredItemRead {
  entry?: DictEntry;
  losses: string[];
}

/** Collapse runs of whitespace to single spaces and trim. Applied to terms and
 * aliases at BOTH read and write, and deliberately NOT counted as a loss: it
 * changes no word, and writing back the collapsed form loses nothing. A newline
 * inside a term is not cosmetic though - it would break the whisper prompt into
 * two lines of pseudo-transcript, which is exactly the shape of the leak storey
 * 1 is bounded to avoid. */
function tidy(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

function readStoredEntry(raw: unknown, at: number): StoredItemRead {
  const where = `entry #${at + 1}`;
  if (typeof raw !== "object" || raw === null) return { losses: [`${where} is not an object`] };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim().length === 0) return { losses: [`${where} has no usable id`] };
  const id = r.id.trim();
  if (typeof r.term !== "string") return { losses: [`${where} (id ${id}) has no term string`] };
  const term = tidy(r.term);
  if (term === "") return { losses: [`${where} (id ${id}) has an empty term`] };

  const losses: string[] = [];
  if (id.length > MAX_ID_CHARS) losses.push(`${where} has an id over ${MAX_ID_CHARS} chars`);
  if (term.length > MAX_TERM_CHARS) losses.push(`${where} (${term.slice(0, 20)}) has a term over ${MAX_TERM_CHARS} chars`);

  // An `aliases` that is present but is not an array is a file we did not
  // understand, not an entry without aliases: reading it as [] and then allowing
  // a write would replace it with one.
  const aliases: string[] = [];
  if (r.aliases !== undefined && !Array.isArray(r.aliases)) {
    losses.push(`${where} (id ${id}) has an aliases field that is not an array`);
  } else if (Array.isArray(r.aliases)) {
    if (r.aliases.length > MAX_ALIASES) {
      losses.push(`${where} (id ${id}) has ${r.aliases.length} aliases, over the ${MAX_ALIASES} cap`);
    }
    for (const [k, a] of r.aliases.slice(0, MAX_ALIASES).entries()) {
      if (typeof a !== "string") {
        losses.push(`${where} (id ${id}) alias #${k + 1} is not a string`);
        continue;
      }
      const clean = tidy(a);
      if (clean === "") continue; // a blank alias never matched anything; nothing is lost by not keeping it
      if (clean.length > MAX_ALIAS_CHARS) {
        losses.push(`${where} (id ${id}) has an alias over ${MAX_ALIAS_CHARS} chars`);
      }
      aliases.push(clean.slice(0, MAX_ALIAS_CHARS));
    }
  }

  // Anything but the literal "replacement" reads as "vocabulary" - the SAFER of
  // the two by construction, since a vocabulary entry never rewrites a single
  // character of a transcript. A garbled kind field must not be able to turn
  // into a substitution rule nobody asked for.
  const kind: DictKind = r.kind === "replacement" ? "replacement" : "vocabulary";
  return {
    entry: {
      id: id.slice(0, MAX_ID_CHARS),
      term: term.slice(0, MAX_TERM_CHARS),
      aliases,
      kind,
      starred: r.starred === true,
      createdIso: typeof r.createdIso === "string" ? r.createdIso : new Date(0).toISOString(),
    },
    losses,
  };
}

/**
 * Pure: turn an already-JSON.parsed value into a trustworthy DictionaryFile, or
 * a documented refusal. Tolerant at the ITEM level, NOT at the version level -
 * and "tolerant" means the load succeeds, not that a loss goes unreported: any
 * drop or truncation sets `error`, which makes the store read-only until the
 * file is fixed. (main/snippets.ts's module note has the full argument.)
 */
export function parseDictionaryFile(raw: unknown): ParsedDictionary {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: "dictionary.json is not a JSON object; left untouched, starting with an empty dictionary",
    };
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== CURRENT_VERSION) {
    return {
      file: { version: CURRENT_VERSION, items: [] },
      error: `dictionary.json has version ${JSON.stringify(r.version)}, which this build does not understand; left untouched, dictionary starts empty`,
    };
  }
  const losses: string[] = [];
  if (r.items !== undefined && !Array.isArray(r.items)) losses.push("the items field is not an array");
  const rawItems = Array.isArray(r.items) ? r.items : [];
  const items: DictEntry[] = [];
  for (const [at, it] of rawItems.entries()) {
    if (items.length >= MAX_ITEMS) {
      losses.push(`the file holds ${rawItems.length} entries, over the ${MAX_ITEMS} cap`);
      break;
    }
    const read = readStoredEntry(it, at);
    losses.push(...read.losses);
    if (read.entry) items.push(read.entry);
  }
  if (losses.length > 0) {
    const shown = losses.slice(0, MAX_REPORTED_LOSSES).join("; ");
    const rest = losses.length - MAX_REPORTED_LOSSES;
    return {
      file: { version: CURRENT_VERSION, items },
      error: `dictionary.json did not load intact, so the dictionary is READ-ONLY until it is fixed (saving now would make the loss permanent): ${shown}${rest > 0 ? `; and ${rest} more` : ""}`,
    };
  }
  return { file: { version: CURRENT_VERSION, items } };
}

/**
 * Pure: what UI_DICT_SAVE does to an items array, given the CURRENT dictionary
 * and the raw IPC payload. Exported and disk-free so the id-lookup-vs-mint rule
 * and the bounds are unit-testable without touching ~/.flow.
 *
 * The id is a LOOKUP key, never a creation key: an id that matches nothing is
 * refused rather than silently minting an entry under a caller-chosen name
 * (main/snippets.ts's module note).
 */
export function applyDictSave(
  items: readonly DictEntry[],
  rawInput: unknown,
): { items: DictEntry[] } | { error: string } {
  // The declared type on the renderer side is a promise, not a fact - same
  // discipline as sanitizeSettings(raw: unknown).
  const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>;
  const requestedId = typeof input.id === "string" ? input.id.trim() : "";
  const term = tidy(typeof input.term === "string" ? input.term : "");
  if (term === "") return { error: "a dictionary entry needs a term" };
  if (term.length > MAX_TERM_CHARS) {
    return { error: `"${term.slice(0, 24)}..." is ${term.length} characters, over the ${MAX_TERM_CHARS} limit for a term` };
  }
  const kind: DictKind = input.kind === "replacement" ? "replacement" : "vocabulary";
  const starred = input.starred === true;

  const aliases: string[] = [];
  const seen = new Set<string>();
  const rawAliases = Array.isArray(input.aliases) ? input.aliases : [];
  for (const a of rawAliases) {
    const clean = tidy(typeof a === "string" ? a : "");
    if (clean === "") continue;
    if (clean.length > MAX_ALIAS_CHARS) {
      return { error: `the alias "${clean.slice(0, 24)}..." is over the ${MAX_ALIAS_CHARS} character limit` };
    }
    // Deduplicated on the NORMALIZED phrase, because that is what actually
    // matches: "Loi vingt-cinq" and "loi vingt cinq" are one alias with two
    // spellings, and keeping both would just spend the entry's budget twice.
    // This is input normalization at the write boundary, not a read-time loss.
    const key = phraseKey(clean) || clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(clean);
    if (aliases.length >= MAX_ALIASES) break;
  }

  if (requestedId) {
    const at = items.findIndex((it) => it.id === requestedId);
    if (at < 0) return { error: `dictionary entry ${requestedId} was not found` };
    const next = items.slice();
    next[at] = { ...items[at], term, aliases, kind, starred };
    return { items: next };
  }

  if (items.length >= MAX_ITEMS) return { error: `the dictionary is full (${MAX_ITEMS} max)` };
  return {
    items: [
      ...items,
      {
        id: randomUUID(), // minted by the STORE, never accepted from the caller
        term,
        aliases,
        kind,
        starred,
        createdIso: new Date().toISOString(),
      },
    ],
  };
}

/** Pure: what UI_DICT_DELETE does. Deleting an id that is already gone is a
 * no-op, not an error - idempotent, matching what a page holding a possibly
 * stale list expects. */
export function applyDictDelete(items: readonly DictEntry[], rawId: unknown): DictEntry[] {
  const id = typeof rawId === "string" ? rawId : "";
  return items.filter((it) => it.id !== id);
}

// ---------------------------------------------------------------------------
// B2 : dictionary.json a disparu. Le dictionnaire vit dans le compte.
//
// CE MODULE EST CELUI QU'IL FALLAIT DEPLACER AVEC LE PLUS D'EGARDS : c'est un
// vocabulaire tape a la main, un terme a la fois, sur des mois. Et c'est aussi
// celui qui porte la deuxieme des sept regressions que le plan demande de
// chercher - « un terme de dictionnaire sans effet, parce que le cache compile
// n'a pas ete rafraichi apres un chargement ».
//
// Cette panne a DEJA eu lieu dans ce produit, il y a deux jours, pour une autre
// raison. Elle est silencieuse par nature : le terme apparait dans la page, il
// est bien enregistre, et il ne change simplement rien a ce qui est dicte. Rien
// n'echoue, rien ne s'affiche en rouge.
//
// La garde est donc structurelle : `refreshDictionaryCache()` est le SEUL
// chemin par lequel des entrees venues du compte entrent dans le cache, et il
// est appele des que la copie de travail a fini de charger. Un test verifie
// qu'un chargement qui ne le rappelle pas laisse un cache perime.
//
// CE QUI DISPARAIT AVEC LE FICHIER, et qu'il ne faut pas regretter :
// l'ecriture atomique tmp + rename, la garde anti-ecrasement (« ne jamais
// reecrire un fichier qu'on n'a pas compris »), et l'etat `missing` qui
// distinguait ENOENT d'un fichier vide. Ils protegeaient tous les trois contre
// des pannes de fichier, et il n'y a plus de fichier. La garde equivalente est
// desormais dans la copie de travail : un chargement rate ne se declare jamais
// « vide ».
// ---------------------------------------------------------------------------

/** Ce que ce module attend de son magasin. La copie de travail
 * (main/data/workingCopy.ts) l'implemente. */
export interface DictionaryBacking {
  readDictionary(): DictEntry[];
  upsertDictEntry(e: DictEntry): void;
  deleteDictEntry(id: string): void;
  /** Faux tant que le compte n'a pas fini de charger. Voir readEntries. */
  isReady(): boolean;
}

let backing: DictionaryBacking | null = null;

export function useDictionaryBacking(b: DictionaryBacking | null): void {
  backing = b;
  cache = null;
  cachedPrompt = null;
}

/**
 * Les entrees du compte, ou null quand il n'y a rien de fiable a rendre.
 *
 * NULL N'EST PAS UNE LISTE VIDE, et c'est toute la subtilite de ce module. Un
 * dictionnaire vide veut dire « cette personne n'a aucun terme » ; null veut
 * dire « on ne sait pas encore ». Les traiter pareil ferait dicter quelqu'un
 * sans ses termes pendant les secondes qui suivent le lancement, ce qui est
 * exactement la panne qu'on cherche a eviter.
 */
function readEntries(): DictEntry[] | null {
  if (!backing || !backing.isReady()) return null;
  return backing.readDictionary();
}

// ---------------------------------------------------------------------------
// The runtime cache (see the module note)
// ---------------------------------------------------------------------------

interface DictCache {
  entries: readonly DictEntry[];
  rules: CompiledDictionary;
}

let cache: DictCache | null = null;
/** One slot: `base` never changes at runtime (it is index.ts's French seed), so
 * a single memo covers every call. Keyed on it anyway, so a second caller with
 * another seed gets a correct answer instead of the first one's. */
let cachedPrompt: { base: string; text: string } | null = null;

function setCache(entries: readonly DictEntry[]): DictCache {
  cache = { entries, rules: compileDictionary(entries) };
  cachedPrompt = null;
  return cache;
}

function ensureCache(): DictCache {
  if (cache) return cache;
  const entries = readEntries();
  // Rien de fiable : on rend un cache VOLATIL sans le retenir. Le mettre en
  // cache figerait « pas de termes » pour tout le reste de la session, alors
  // que le compte finit de charger une seconde plus tard.
  if (entries === null) return { entries: [], rules: compileDictionary([]) };
  return setCache(entries);
}

/**
 * Le SEUL chemin par lequel des entrees venues du compte entrent dans le cache.
 *
 * Appele quand la copie de travail a fini de charger. Sans cet appel, le cache
 * compile garde la table de regles d'avant la connexion, la page montre les
 * termes, et aucun n'a d'effet sur ce qui est dicte : la deuxieme des sept
 * regressions du plan, dans sa forme exacte.
 */
export function refreshDictionaryCache(): void {
  const entries = readEntries();
  if (entries !== null) setCache(entries);
}

/** Storey 1: the whisper initial prompt for THIS dictionary. Returns `base`
 * unchanged when there is nothing to add, so an empty dictionary produces
 * exactly the prompt Flow sent before this feature existed. Never throws: it is
 * called from the inference path, where an exception would cost the user his
 * utterance, not just his dictionary. (The budget is not a parameter here -
 * shared/dictionary.ts owns it, and the tests exercise the bound on the pure
 * builder rather than through this cache.) */
export function dictationPrompt(base: string): string {
  try {
    if (cachedPrompt !== null && cachedPrompt.base === base) return cachedPrompt.text;
    const text = buildDictationPrompt(base, ensureCache().entries);
    cachedPrompt = { base, text };
    return text;
  } catch {
    return base;
  }
}

/** Storey 2: rewrite a final transcript. Called once per utterance from
 * main/index.ts's processUtterance, AFTER gateTranscript and BEFORE insertion.
 * Linear in the text, independent of the number of rules, and a no-op (the same
 * string instance back) for a user with no replacement rules. */
export function applyDictionaryReplacements(text: string): string {
  try {
    return applyDictionary(text, ensureCache().rules);
  } catch {
    // A dictation must land even if the dictionary is somehow broken: the raw
    // transcript is always better than nothing at the cursor.
    return text;
  }
}

// ---------------------------------------------------------------------------
// U6e: what a fresh install starts with
// ---------------------------------------------------------------------------
/**
 * A short, opinionated starter list, written ONCE (see primeDictionary) and
 * fully owned by the user afterwards: he can edit or delete every line, and a
 * deletion is never resurrected, because the seeding trigger is "there is no
 * dictionary.json at all", not "the dictionary is empty".
 *
 * "Claude" is the reason this list exists. The engine transcribes it "Cloud"
 * (observed on Roch's own dictation, 2026-07-27), and someone dictating INTO
 * Claude Code should not have to teach Flow the name of the tool he is talking
 * to. It ships as VOCABULARY, not as a replacement, and that is the careful
 * part: "cloud" is an ordinary English word, so a blind cloud -> Claude rule
 * would rewrite "the cloud provider" too. Storey 1 biases the decoder toward
 * the right spelling without ever touching a transcript. The one substitution
 * shipped for it is the unambiguous two-word phrase "cloud code", which nobody
 * says meaning anything else.
 *
 * The rest are the maquette's own five (design/mockup.html, Dictionary page)
 * plus the names that recur in this repo. Each is a real name Flow has a real
 * chance of getting wrong; none is a common word on its own.
 */
export function defaultEntries(): DictEntry[] {
  const createdIso = new Date().toISOString();
  const make = (
    term: string,
    kind: DictKind,
    starred: boolean,
    aliases: string[] = [],
  ): DictEntry => ({ id: randomUUID(), term, aliases, kind, starred, createdIso });
  return [
    make("Claude", "vocabulary", true),
    make("Claude Code", "replacement", true, ["cloud code"]),
    make("AGR Labs", "replacement", true, ["agile air", "a g r labs"]),
    make("whisper.cpp", "vocabulary", true),
    // Unstarred ON PURPOSE, and the only shipped entry that can be: a
    // replacement works after the fact, so it costs the prompt nothing. It is
    // also the example the page needs of what an unstarred entry still does.
    make("Loi 25", "replacement", false, ["loi vingt-cinq"]),
    // Starred since the review's constat 6: a vocabulary entry acts ONLY
    // through the prompt, and the prompt now carries starred terms only, so an
    // unstarred vocabulary default would be a term Flow claims to know and does
    // nothing about. Two short names cost ~20 of the 320 prompt characters.
    make("keyspy", "vocabulary", true),
    make("Tailscale", "vocabulary", true, ["tail scale"]),
  ];
}

/**
 * Boot: warm the runtime cache and, on a machine that has never had a
 * dictionary.json, write the shipped defaults exactly once.
 *
 * The trigger is `missing` (ENOENT), never "items is empty": a user who deletes
 * every entry leaves a file holding `items: []`, and the next launch must
 * respect that instead of handing him his deleted terms back. That is the whole
 * difference between a default and a nag.
 *
 * A failed seed write is not fatal - the defaults are used in memory for this
 * run and the write is retried at the next launch - because "Flow could not
 * write a file" is not a reason to also stop recognizing "Claude".
 */
export function primeDictionary(log?: (msg: string) => void): void {
  const entries = readEntries();
  if (entries === null) return; // pas encore connecte : rien a semer, rien a dire
  if (entries.length > 0) {
    setCache(entries);
    return;
  }
  // Un compte NEUF n'a aucun terme. On y ecrit les defauts une fois, par le
  // magasin, exactement comme un utilisateur les aurait ajoutes.
  //
  // LE DECLENCHEUR A CHANGE ET IL FAUT LE DIRE : avant, c'etait ENOENT - « il
  // n'y a pas de fichier » - jamais « la liste est vide », precisement pour ne
  // pas rendre ses termes a quelqu'un qui les a tous supprimes. Cette
  // distinction n'existe plus : une table vide et un compte neuf se
  // ressemblent. Quelqu'un qui supprime son dernier terme les reverra donc au
  // prochain lancement. C'est le prix de la migration, il est petit, et il vaut
  // mieux l'ecrire ici que de le decouvrir.
  const items = defaultEntries();
  for (const e of items) backing?.upsertDictEntry(e);
  setCache(items);
  log?.(`[dict] compte neuf : ${items.length} termes par defaut ajoutes`);
}

// ---------------------------------------------------------------------------
// The three IPC operations. Every one answers with the WHOLE dictionary, so the
// page can never hold a stale list after a write it did not itself make.
// ---------------------------------------------------------------------------

/**
 * UI_DICT_LIST. Also refreshes the runtime cache: the page asking for the list
 * is the cheapest moment to notice a file someone edited by hand.
 *
 * ONLY on a read that succeeded, which is the review's constat 4. loadDictionary
 * File answers with an EMPTY dictionary on any failure - unreadable bytes, a
 * version this build refuses, a file an antivirus is holding open - and the old
 * code took that empty answer as the new truth. Opening the Dictionary page
 * against a broken file therefore emptied the cache for the rest of the session,
 * silently disarming storey 2 on the dictation path as well: the user came to
 * LOOK at his dictionary and lost the use of it. The write paths already got
 * this right (they return before touching the cache on `error`); this is the
 * read catching up. A cache that is stale beats a cache that is wrong - and the
 * error still travels to the page, which is where a broken file gets fixed.
 *
 * `missing` still refreshes the cache, because ENOENT is not a failed read: it
 * is a successful reading of "there is no file", and the empty cache that
 * follows matches both the disk and what the page is being shown.
 */
export function listDictionary(): DictResult {
  const entries = readEntries();
  if (entries === null) {
    // La page a ouvert le dictionnaire avant que le compte ait fini de charger.
    // On le DIT plutot que de montrer une liste vide : une liste vide se lit
    // « vous n'avez aucun terme », ce qui est faux et alarmant.
    return { ok: false, items: [], error: "le dictionnaire du compte n'est pas encore charge" };
  }
  setCache(entries);
  return { ok: true, items: entries };
}

/** UI_DICT_SAVE: create when the input carries no id, else update in place. */
export function saveDictEntry(rawInput: unknown): DictResult {
  const entries = readEntries();
  if (entries === null) return { ok: false, items: [], error: "le dictionnaire du compte n'est pas encore charge" };
  const applied = applyDictSave(entries, rawInput);
  if ("error" in applied) return { ok: false, items: entries, error: applied.error };

  // La ligne qui a change, et qui merite d'etre lue deux fois : on n'ecrit pas
  // LA LISTE, on ecrit L'ENTREE. Envoyer la liste entiere ferait qu'une machine
  // effacerait les termes qu'une autre vient d'ajouter - deux ordinateurs, un
  // dictionnaire, et le dernier qui enregistre gagne. Une entree a la fois
  // laisse la base fusionner.
  const touched = applied.items.find((e) => !entries.some((o) => o.id === e.id && o === e));
  if (touched) backing?.upsertDictEntry(touched);

  // Reconstruit depuis les entrees deja en main : le prompt et la table de
  // regles du prochain enonce sont a jour SANS aucun aller-retour reseau.
  setCache(applied.items);
  return { ok: true, items: applied.items };
}

/** UI_DICT_DELETE. */
export function deleteDictEntry(rawId: unknown): DictResult {
  const entries = readEntries();
  if (entries === null) return { ok: false, items: [], error: "le dictionnaire du compte n'est pas encore charge" };
  const next = applyDictDelete(entries, rawId);
  if (next.length === entries.length) return { ok: true, items: entries }; // rien ne correspondait : sans effet
  const gone = entries.find((e) => !next.some((n) => n.id === e.id));
  if (gone) backing?.deleteDictEntry(gone.id);
  setCache(next);
  return { ok: true, items: next };
}

/** Tests only: drop the runtime cache so the next call re-reads. Never called
 * by the app - the write paths keep the cache correct by construction. */
export function resetDictionaryCacheForTests(): void {
  cache = null;
  cachedPrompt = null;
}
