import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDictionary,
  compileDictionary,
  adaptCase,
  phraseKey,
  termSelfKey,
  tokenizeForDictionary,
  MAX_PHRASE_WORDS,
} from "../src/shared/dictionary";
import type { DictEntry } from "../src/shared/ipcContracts";

// U6a/U6c: the PURE matching half. Everything here is disk-free and
// Electron-free by construction (the store's own tests live in
// test/dictionary-store.test.ts), which is the whole reason the matching rules
// were pushed into src/shared in the first place: they are the part with real
// edge cases - accents, casing, word boundaries, phrases - and they must be
// arguable without an app around them.

function entry(over: Partial<DictEntry> = {}): DictEntry {
  return {
    id: over.id ?? "id-1",
    term: over.term ?? "Loi 25",
    aliases: over.aliases ?? ["loi vingt-cinq"],
    kind: over.kind ?? "replacement",
    starred: over.starred ?? false,
    createdIso: over.createdIso ?? "2026-01-01T00:00:00.000Z",
  };
}

function rewrite(text: string, entries: DictEntry[]): string {
  return applyDictionary(text, compileDictionary(entries));
}

// ---------------------------------------------------------------------------
// Tokenizing: the foundation every "never cuts a word" claim rests on
// ---------------------------------------------------------------------------

test("tokenize: maximal [a-z0-9] runs, accents folded, spans point into the ORIGINAL text", () => {
  const text = "La réunion d'AGR Labs, 2026.";
  const toks = tokenizeForDictionary(text);
  assert.deepEqual(
    toks.map((t) => t.norm),
    ["la", "reunion", "d", "agr", "labs", "2026"],
  );
  // Spans are into the original, accents and all - that is what lets a
  // replacement rewrite exactly the matched characters.
  assert.equal(text.slice(toks[1].start, toks[1].end), "réunion");
  assert.equal(text.slice(toks[3].start, toks[4].end), "AGR Labs");
});

test("tokenize: an astral character advances by its true length (no span lands mid-surrogate)", () => {
  const text = "bonjour 🙂 loi";
  const toks = tokenizeForDictionary(text);
  assert.deepEqual(
    toks.map((t) => text.slice(t.start, t.end)),
    ["bonjour", "loi"],
  );
});

test("phraseKey: a pattern with no word, or one longer than the cap, matches nothing", () => {
  assert.equal(phraseKey("  "), "");
  assert.equal(phraseKey("---"), "");
  assert.equal(phraseKey("a b c d e f g"), "", `over ${MAX_PHRASE_WORDS} words`);
  assert.equal(phraseKey("Loi vingt-cinq"), "loi vingt cinq");
});

// ---------------------------------------------------------------------------
// The headline behaviours the wave asked for
// ---------------------------------------------------------------------------

test("« loi vingt-cinq » comes out « Loi 25 »", () => {
  assert.equal(rewrite("Il faut respecter la loi vingt-cinq ici.", [entry()]), "Il faut respecter la Loi 25 ici.");
});

test("accents and casing on BOTH sides: the alias matches however it was written", () => {
  const e = entry({ term: "Réunion Q3", aliases: ["reunion q trois"] });
  assert.equal(rewrite("une reunion q trois demain", [e]), "une Réunion Q3 demain");
  assert.equal(rewrite("une réunion q trois demain", [e]), "une Réunion Q3 demain");
  assert.equal(rewrite("une RÉUNION Q TROIS demain", [e]), "une RÉUNION Q3 demain");
});

test("the term itself is a pattern, so a flat spelling gets its casing and punctuation back", () => {
  assert.equal(rewrite("on utilise whisper cpp", [entry({ term: "whisper.cpp", aliases: [] })]), "on utilise whisper.cpp");
  assert.equal(rewrite("chez agr labs", [entry({ term: "AGR Labs", aliases: [] })]), "chez AGR Labs");
  // Already correct: rewriting to itself, byte for byte.
  assert.equal(rewrite("chez AGR Labs", [entry({ term: "AGR Labs", aliases: [] })]), "chez AGR Labs");
});

test("NEVER inside a longer word - the one thing a naive indexOf/regex gets wrong", () => {
  const e = entry({ term: "Loi 25", aliases: ["loi"] });
  for (const text of ["mon emploi du temps", "la loiterie", "xloix", "emploiloi"]) {
    assert.equal(rewrite(text, [e]), text, text);
  }
  // The same rule DOES fire when the word stands alone, so the test above is
  // about boundaries and not about the rule being broken.
  assert.equal(rewrite("la loi du 25", [e]), "la Loi 25 du 25");
});

test("a multi-word rule never spans a sentence boundary", () => {
  const e = entry({ term: "Loi 25", aliases: ["loi vingt cinq"] });
  // "...de la loi. Vingt-cinq personnes..." holds the three words in order and
  // must NOT be spliced into "...de la Loi 25 personnes...".
  const text = "Il connaît la loi. Vingt-cinq personnes sont venues.";
  assert.equal(rewrite(text, [e]), text);
  // Nor across a comma, a colon or a newline.
  for (const sep of [", ", " : ", "\n"]) {
    const t = `la loi${sep}vingt cinq personnes`;
    assert.equal(rewrite(t, [e]), t, JSON.stringify(sep));
  }
});

test("a multi-word rule DOES span the separators a single term legitimately contains", () => {
  const e = entry({ term: "whisper.cpp", aliases: [] });
  for (const written of ["whisper.cpp", "whisper cpp", "whisper-cpp", "whisper  cpp"]) {
    assert.equal(rewrite(`avec ${written} local`, [e]), "avec whisper.cpp local", written);
  }
});

test("the longest rule wins at a given position", () => {
  const entries = [
    entry({ id: "short", term: "Claude", aliases: ["cloud"], kind: "replacement" }),
    entry({ id: "long", term: "Claude Code", aliases: ["cloud code"], kind: "replacement" }),
  ];
  assert.equal(rewrite("j'ouvre cloud code", entries), "j'ouvre Claude Code");
  assert.equal(rewrite("j'ouvre cloud", entries), "j'ouvre Claude");
});

test("a vocabulary entry NEVER rewrites anything - the whole reason « Claude » ships as one", () => {
  const claude = entry({ term: "Claude", aliases: ["cloud"], kind: "vocabulary" });
  const text = "notre fournisseur cloud est correct";
  assert.equal(rewrite(text, [claude]), text);
  assert.equal(compileDictionary([claude]).maxWords, 0, "a vocabulary-only dictionary compiles to no rules at all");
});

test("casing: SHOUTED matches shout back, sentence-initial capitals survive, deliberate casing is not undone", () => {
  assert.equal(adaptCase("Loi 25", "loi vingt-cinq"), "Loi 25");
  assert.equal(adaptCase("Loi 25", "LOI VINGT-CINQ"), "LOI 25");
  // The canonical form starts lowercase on purpose (whisper.cpp): a capital in
  // the match came from the sentence, so only the first letter follows.
  assert.equal(adaptCase("whisper.cpp", "Whisper cpp"), "Whisper.cpp");
  assert.equal(adaptCase("whisper.cpp", "whisper cpp"), "whisper.cpp");
  // ...and a term that is deliberately mixed-case is never re-cased by a
  // Capitalized match.
  assert.equal(adaptCase("AGR Labs", "Agr labs"), "AGR Labs");
  // A digits-only match carries no casing signal at all.
  assert.equal(adaptCase("Loi 25", "25"), "Loi 25");
});

// ---------------------------------------------------------------------------
// Review constat 3: a term whose identity IS its punctuation
// ---------------------------------------------------------------------------
// compileDictionary adds the term itself as a pattern, and the key keeps only
// letters and digits. Measured: ".NET" became "net", "C#" became "c" and "C++"
// became "c" as well. So an entry for .NET rewrote the ordinary word "net"
// everywhere it appeared, and two distinct terms claimed one key - the first to
// be compiled swallowing the other. The self-pattern is now granted only when
// the key spells the term back (termSelfKey); the way to ask for a match that
// the key cannot express is an alias, which is a statement rather than a guess.

test("termSelfKey: granted when the key spells the term back, refused when it destroys it", () => {
  assert.equal(termSelfKey("AGR Labs"), "agr labs");
  assert.equal(termSelfKey("whisper.cpp"), "whisper cpp", "a dot BETWEEN two tokens is a legal separator");
  assert.equal(termSelfKey("Loi 25"), "loi 25");
  assert.equal(termSelfKey("X"), "x", "a one-letter term is exactly what the user typed - nothing is destroyed");
  assert.equal(termSelfKey("Réunion Q3"), "reunion q3");
  for (const destroyed of [".NET", "C#", "C++", "e.g.", "#hashtag", "(paren)"]) {
    assert.equal(termSelfKey(destroyed), "", `${destroyed} must not claim a rule the key cannot spell back`);
  }
});

test("an entry for « .NET » does not rewrite the word « net »", () => {
  const dotnet = entry({ id: "dotnet", term: ".NET", aliases: [] });
  for (const text of ["le solde net est de 25", "net", "un profit net"]) {
    assert.equal(rewrite(text, [dotnet]), text, text);
  }
  // The alias is how the user asks for the match, and it still works.
  const withAlias = entry({ id: "dotnet", term: ".NET", aliases: ["dot net"] });
  assert.equal(rewrite("on code en dot net", [withAlias]), "on code en .NET");
});

test("« C# » and « C++ » are two terms, not one - and neither claims the letter « c »", () => {
  const entries = [
    entry({ id: "sharp", term: "C#", aliases: ["c sharp", "c dièse"] }),
    entry({ id: "plus", term: "C++", aliases: ["c plus plus"] }),
  ];
  const text = "la réponse c est simple";
  assert.equal(rewrite(text, entries), text, "one term captured the bare letter c");
  assert.equal(rewrite("j'écris du c sharp", entries), "j'écris du C#");
  assert.equal(rewrite("j'écris du c plus plus", entries), "j'écris du C++", "the second term was swallowed by the first");
});

test("a single-letter term keeps its self-rule: nothing about it was destroyed", () => {
  assert.equal(rewrite("la variable x vaut deux", [entry({ term: "X", aliases: [] })]), "la variable X vaut deux");
});

// ---------------------------------------------------------------------------
// Review constat 5: an acronym alias is not a raised voice
// ---------------------------------------------------------------------------

test("an ACRONYM alias does not make the replacement shout", () => {
  // "two or more characters, all upper case" is the shape of an acronym, and an
  // acronym is the most natural alias anyone adds for a term. Under that rule,
  // teaching Flow that CC means Claude Code made every calm sentence come back
  // with CLAUDE CODE in the middle of it.
  const cc = entry({ term: "Claude Code", aliases: ["CC"] });
  assert.equal(rewrite("ouvre CC maintenant", [cc]), "ouvre Claude Code maintenant");
  assert.equal(adaptCase("Claude Code", "CC"), "Claude Code");
  assert.equal(adaptCase("AGR Labs", "AGR"), "AGR Labs");
  assert.equal(adaptCase("Tailscale", "TAILSCALE"), "Tailscale", "one word in capitals is an acronym's shape, not a voice");
});

test("a shout still shouts: capitals over two or more words are the actual signal", () => {
  assert.equal(adaptCase("Loi 25", "LOI VINGT-CINQ"), "LOI 25");
  assert.equal(rewrite("RESPECTE LA LOI VINGT-CINQ", [entry()]), "RESPECTE LA LOI 25");
  // The accepted residue, named rather than hidden: the letter count is what
  // decides, so a match whose only word is followed by a number ("LOI 25")
  // comes back in the term's own spelling. Wrong in the safe direction - the
  // user gets exactly what he asked Flow to write.
  assert.equal(adaptCase("Loi 25", "LOI 25"), "Loi 25");
});

test("everything outside a match is copied through byte for byte", () => {
  const e = entry();
  const text = "  Déjà :\tla loi vingt-cinq — voilà 😀 (fin)\n";
  assert.equal(rewrite(text, [e]), "  Déjà :\tla Loi 25 — voilà 😀 (fin)\n");
});

test("two matches in one utterance, and adjacent ones", () => {
  const entries = [entry(), entry({ id: "id-2", term: "AGR Labs", aliases: ["agile air"] })];
  assert.equal(
    rewrite("agile air applique la loi vingt-cinq", entries),
    "AGR Labs applique la Loi 25",
  );
  assert.equal(rewrite("agile air agile air", entries), "AGR Labs AGR Labs");
});

// ---------------------------------------------------------------------------
// Compilation rules
// ---------------------------------------------------------------------------

test("compile: an empty or rule-free dictionary is the fast path, and returns the SAME string instance", () => {
  const dict = compileDictionary([]);
  assert.equal(dict.maxWords, 0);
  const text = "rien à faire ici";
  assert.equal(applyDictionary(text, dict), text);
});

test("compile: the first entry to claim a normalized phrase keeps it", () => {
  const entries = [
    entry({ id: "first", term: "Premier", aliases: ["ambigu"] }),
    entry({ id: "second", term: "Second", aliases: ["Ambigu"] }),
  ];
  assert.equal(rewrite("mot ambigu ici", entries), "mot Premier ici");
});

test("compile: blank aliases and over-long phrases are simply not rules", () => {
  const e = entry({ term: "X", aliases: ["   ", "---", "un deux trois quatre cinq six sept"] });
  const dict = compileDictionary([e]);
  // Only the term itself ("x") became a rule.
  assert.equal(dict.rules.size, 1);
  assert.equal(dict.maxWords, 1);
});

test("compile: an entry with a blank term contributes nothing", () => {
  assert.equal(compileDictionary([entry({ term: "   ", aliases: ["quoi que ce soit"] })]).maxWords, 0);
});

// ---------------------------------------------------------------------------
// U6b's non-leak property, on the side that IS replayable
// ---------------------------------------------------------------------------

test("NON-LEAK: a short utterance holding no dictionary term comes back byte-identical", () => {
  // A real decode cannot be replayed in a unit test, so the leak is proven on
  // both halves of what CAN be: the prompt builder is bounded and never carries
  // an alias (test/dictionary-prompt.test.ts), and storey 2 - the only code
  // that can put a dictionary term into a transcript AFTER the model has spoken
  // - never invents one. This is that second half, on the kind of text a 2 s
  // dictation actually produces, against a dictionary far larger than anyone's.
  const entries: DictEntry[] = [
    entry({ id: "a", term: "Claude Code", aliases: ["cloud code"] }),
    entry({ id: "b", term: "AGR Labs", aliases: ["agile air", "a g r labs"] }),
    entry({ id: "c", term: "Loi 25", aliases: ["loi vingt-cinq"] }),
    entry({ id: "d", term: "whisper.cpp", aliases: [] }),
    entry({ id: "e", term: "Tailscale", aliases: ["tail scale"] }),
    ...Array.from({ length: 60 }, (_, i) =>
      entry({ id: `x${i}`, term: `Terme${i}`, aliases: [`alias numero ${i}`] }),
    ),
  ];
  const dict = compileDictionary(entries);
  const shortUtterances = [
    "oui",
    "d'accord merci",
    "on se voit demain matin",
    "il faut que je rappelle le client avant midi",
    "peux-tu m'envoyer le document par courriel",
    "c'est correct comme ça",
    "je pense que la loi est claire",
    "le nuage était gris ce matin",
    "vingt-cinq personnes sont venues",
    "code source",
    "bonjour",
    "",
  ];
  for (const u of shortUtterances) {
    assert.equal(applyDictionary(u, dict), u, `storey 2 invented something in ${JSON.stringify(u)}`);
  }
});

test("NON-LEAK: a term only ever appears where its own words were actually said", () => {
  const e = entry({ term: "Loi 25", aliases: ["loi vingt-cinq"] });
  const dict = compileDictionary([e]);
  // The near-misses: every word of the alias present but not as the phrase.
  for (const text of ["la loi et le vingt-cinq du mois", "vingt-cinq lois", "loi", "vingt-cinq"]) {
    assert.equal(applyDictionary(text, dict).includes("Loi 25"), false, text);
  }
});

// ---------------------------------------------------------------------------
// The hot-path bound, asserted rather than asserted-in-a-comment
// ---------------------------------------------------------------------------

test("cost is linear in the text and independent of the rule count", () => {
  // The naive shape (loop over the rules, replace each across the text) is
  // O(rules x text): it would get slower every time the user taught Flow a
  // word. The check is deliberately coarse - a ratio, not a millisecond budget
  // - so it fails on a change of COMPLEXITY and not on a slow CI machine.
  const text = ("bonjour ceci est une phrase ordinaire de dictee sans aucun terme special. ").repeat(400);
  const few = compileDictionary([entry({ id: "one", term: "Alpha", aliases: ["a b"] })]);
  const many = compileDictionary(
    Array.from({ length: 2000 }, (_, i) => entry({ id: `m${i}`, term: `T${i}`, aliases: [`alias ${i} bis`] })),
  );
  const time = (dict: ReturnType<typeof compileDictionary>): number => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) applyDictionary(text, dict);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  time(few); // warm the JIT so the first measurement does not carry compilation
  const withFew = Math.max(time(few), 0.5);
  const withMany = time(many);
  assert.ok(
    withMany < withFew * 5,
    `2000 rules cost ${withMany.toFixed(1)} ms against ${withFew.toFixed(1)} ms for 1 - that is rule-count sensitivity, not a slow machine`,
  );
});

// ---------------------------------------------------------------------------
// 2026-08-03. Roch a signale une entree du dictionnaire qui ne faisait rien :
// il avait appris a Flow que « D&D » s'ecrit « DND ».
//
// Tout dans l'entree etait juste. L'alias compilait vers la cle "d d", le texte
// dicte se tokenisait en "d","d", et les deux correspondaient. Le remplacement
// n'arrivait jamais parce que l'ECART entre les deux jetons etait « & », qui
// n'etait pas joignable : la cle a deux mots n'etait donc jamais CONSTRUITE, et
// la recherche qui aurait reussi n'etait jamais tentee.
// ---------------------------------------------------------------------------

test("un alias joint par une esperluette fonctionne (D&D, R&D, AT&T)", () => {
  const c = compileDictionary([
    { id: "1", term: "DND", kind: "replacement", starred: false, aliases: ["D&D"] },
    { id: "2", term: "recherche et developpement", kind: "replacement", starred: false, aliases: ["R&D"] },
  ]);
  assert.equal(applyDictionary("Je travaille au D&D cette semaine.", c), "Je travaille au DND cette semaine.");
  // « R&D » compte pour UN mot, pas deux : sans ca la regle du cri se
  // declenchait et rendait « RECHERCHE ET DEVELOPPEMENT » au milieu d'une
  // phrase calme - le defaut meme que cette regle existe pour eviter. La
  // capitale initiale qui reste vient d'une autre regle, sur l'acronyme etendu.
  assert.equal(applyDictionary("On fait de la R&D.", c), "On fait de la Recherche et developpement.");
});

test("l'esperluette reste insensible a la casse, comme les autres connecteurs", () => {
  const c = compileDictionary([{ id: "1", term: "DND", kind: "replacement", starred: false, aliases: ["D&D"] }]);
  assert.equal(applyDictionary("au d&d demain", c), "au DND demain");
});

test("une esperluette ENTOURÉE D'ESPACES ne joint rien : « Marks & Spencer » reste deux phrases", () => {
  // La distinction qui fait que le correctif est etroit plutot que commode : un
  // « & » colle est un connecteur INTERNE a un nom ; un « & » espace joint des
  // mots qui etaient deja separes, et ce n'est pas la meme affirmation.
  const c = compileDictionary([
    { id: "1", term: "MS", kind: "replacement", starred: false, aliases: ["marks spencer"] },
  ]);
  assert.equal(applyDictionary("Marks & Spencer ouvre demain.", c), "Marks & Spencer ouvre demain.");
});

test("les connecteurs deja acceptes n'ont pas regresse", () => {
  const c = compileDictionary([
    { id: "1", term: "whisper.cpp", kind: "replacement", starred: false, aliases: ["whisper cpp"] },
    { id: "2", term: "Loi 25", kind: "replacement", starred: false, aliases: ["loi vingt-cinq"] },
  ]);
  assert.equal(applyDictionary("whisper.cpp est rapide", c), "whisper.cpp est rapide");
  assert.equal(applyDictionary("la loi vingt-cinq", c), "la Loi 25");
  // Et la garde d'origine tient toujours : un point SUIVI D'UNE ESPACE est une
  // fin de phrase, jamais un connecteur.
  const c2 = compileDictionary([{ id: "3", term: "Loi 25", kind: "replacement", starred: false, aliases: ["loi vingt"] }]);
  assert.equal(applyDictionary("de la loi. Vingt personnes", c2), "de la loi. Vingt personnes");
});
