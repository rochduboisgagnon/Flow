// French WER bench: `npm run bench:wer`.
//
//   npm run bench:wer -- --synthesize   speak the corpus with a Windows voice
//   npm run bench:wer -- --record       record the corpus in Roch's own voice
//   npm run bench:wer                   measure
//
// TWO AUDIO SOURCES, AND THE BENCH ALWAYS SAYS WHICH ONE IT MEASURED:
// the corpus ships as TEXT only, so it needs a voice before it means anything.
// There are two, they measure different things, and confusing them would be the
// most expensive mistake this bench could make.
//
//   SYNTHESIS (audio/synth/<id>.wav, `--synthesize`) is reproducible on any
//   Windows machine in about a minute, and it measures the PROCESSING CHAIN -
//   the model, the initial prompt, the dictionary, the normalization. It does
//   NOT measure speech: no Quebec accent, no hesitation, no room, no
//   microphone. A synthesized number is a regression detector for the chain,
//   never an estimate of what Roch will experience.
//
//   REAL VOICE (audio/<id>.wav, `--record`) is the one that answers "how well
//   does Flow transcribe ME". It costs twenty minutes of Roch's time, once.
//
// The bench PREFERS the real recording, per utterance, whenever it finds one -
// so a half-recorded corpus improves the moment a file lands, with no flag to
// remember. And every table it prints carries the source in a column of its
// own, because a WER that travels without its source label becomes a lie about
// six months from now, when nobody remembers which voice produced it.
//
// WHY THIS EXISTS AND WHY IT COMES FIRST (plan §4.2, task C8):
// everything queued behind it in the campaign claims to improve transcription
// quality - the dictionary that just landed, the import that follows, an
// embedded local LLM, possibly a second ASR backend. Without a bench, "it is
// better" is an opinion, and the campaign's own rule (§1.2) forbids announcing
// an improvement without a measurement. The WER has never been measured in this
// project.
//
// WHAT IT TALKS TO, AND WHAT IT DELIBERATELY DOES NOT TOUCH:
// like scripts/bench-latency.ts, it drives its OWN WhisperSidecar - the exact
// production class, on a port of its own from the same 8178-8199 range, so a
// packaged Flow running beside it is neither used nor disturbed. It never calls
// the app's local API, never imports main/settings.ts or main/dictionary.ts,
// and therefore never reads or writes ~/.flow: a bench that measured the live
// installation's current settings would produce a number nobody could
// reproduce, and one that wrote there could damage a working install. The only
// thing it reads outside this repo is the model file itself.
//
// ZERO EXIT ON THE MACHINE: the corpus audio is read from disk, decoded in RAM,
// posted to loopback and dropped. Nothing is uploaded, nothing is stored beyond
// the WAVs produced on this machine. Synthesis is Windows' own offline engine;
// it reaches no network either.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { WhisperSidecar } from "../src/main/asr/sidecar";
import { modelPath, modelsDir, AVAILABLE_MODELS, DEFAULT_MODEL_FILE } from "../src/main/asr/modelStore";
import { analyzeSpeech, hasSpeech, trimToSpeech } from "../src/shared/vad";
import { encodeWav, SAMPLE_RATE } from "../src/shared/wav";
import { gateTranscript } from "../src/shared/textGate";
import { applyDictionary, buildDictationPrompt, compileDictionary } from "../src/shared/dictionary";
import type { DictEntry } from "../src/shared/ipcContracts";
import { aggregateWer, termHits, wordErrorRate, type WerResult, type WerTotals } from "../src/shared/wer";

// The production constants, copied rather than imported: src/main/index.ts is
// an Electron module and importing it would drag the whole app in. They are
// PRINTED in the report header, so a run always states the configuration it
// measured instead of leaving the reader to assume it.
const FRENCH_PROMPT = "Transcription en français, avec la ponctuation et les accents.";
const BEAM_SIZE = 5;
const LANGUAGE = "fr";

const BINS = [
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-vulkan.exe"),
  path.join(__dirname, "..", "resources", "bin", "whisper-server-win32-x64-cpu.exe"),
];
const CORPUS_DEFAULT = path.join(__dirname, "..", "test", "fixtures", "wer-corpus", "corpus.json");

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface CorpusUtterance {
  id: string;
  categories: string[];
  text: string;
  terms: string[];
}
interface CorpusDictEntry {
  term: string;
  kind: string;
  starred: boolean;
  aliases: string[];
}
interface Corpus {
  version: number;
  language: string;
  dictionary: CorpusDictEntry[];
  utterances: CorpusUtterance[];
}

function loadCorpus(file: string): Corpus {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Corpus>;
  if (!Array.isArray(raw.utterances)) throw new Error(`${file}: no utterances array`);
  const seen = new Set<string>();
  for (const u of raw.utterances) {
    if (!u.id || !u.text) throw new Error(`${file}: an utterance has no id or no text`);
    if (seen.has(u.id)) throw new Error(`${file}: duplicate id ${u.id}`);
    seen.add(u.id);
  }
  return {
    version: raw.version ?? 1,
    language: raw.language ?? "fr",
    dictionary: raw.dictionary ?? [],
    utterances: raw.utterances,
  };
}

/** The corpus's OWN dictionary, turned into the shape shared/dictionary.ts
 * eats. Deliberately not the user's ~/.flow/dictionary.json: a bench whose
 * result moves because Roch starred a term this morning is not a bench. */
function corpusEntries(c: Corpus): DictEntry[] {
  return c.dictionary.map((d, i) => ({
    id: `corpus-${i}`,
    term: d.term,
    aliases: d.aliases ?? [],
    kind: d.kind === "replacement" ? "replacement" : "vocabulary",
    starred: d.starred === true,
    createdIso: "2026-01-01T00:00:00.000Z",
  }));
}

// ---------------------------------------------------------------------------
// Where the audio lives, and which one wins
// ---------------------------------------------------------------------------

/** Which voice produced the clip. Carried per utterance, aggregated per run,
 * and printed in every table - see the module note. */
type AudioSource = "reel" | "synth";

function audioDir(corpusFile: string): string {
  return path.join(path.dirname(corpusFile), "audio");
}

/** Review C8: every audio path is built from a corpus `id`, and the promise
 * that a recording of your voice never enters this PUBLIC repo rests on one
 * .gitignore line covering `audio/`. A path that escapes that directory would
 * be tracked - so an id that is not a plain name is refused outright rather
 * than sanitized into something plausible. The corpus is ours, which makes this
 * a typo guard rather than an attack guard, but a typo is exactly how a private
 * recording would end up committed, and nobody would notice. */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function safeId(id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `corpus id refusé : ${JSON.stringify(id)}. Un id doit être un nom simple ` +
        `(lettres, chiffres, - et _), parce qu'il devient un nom de fichier sous ` +
        `audio/, le seul dossier que .gitignore protège.`,
    );
  }
  return id;
}
/** Roch's own recordings. */
function audioPath(corpusFile: string, id: string): string {
  return path.join(audioDir(corpusFile), `${safeId(id)}.wav`);
}
/** The synthesized ones, NESTED under audio/ on purpose: .gitignore already
 * excludes `audio/`, so the synthetic clips inherit the same fence as the real
 * voice with no second rule to keep in sync (and none to forget). */
function synthDir(corpusFile: string): string {
  return path.join(audioDir(corpusFile), "synth");
}
function synthPath(corpusFile: string, id: string): string {
  return path.join(synthDir(corpusFile), `${safeId(id)}.wav`);
}

/**
 * The clip to measure for one utterance, real voice first.
 *
 * The preference is automatic and per-utterance rather than per-run: recording
 * 24 sentences in one sitting is exactly the kind of chore that gets done in
 * three sittings, and a bench that ignored the first eight until the
 * twenty-fourth landed would punish the person doing the work.
 */
function resolveAudio(corpusFile: string, id: string): { file: string; source: AudioSource } | null {
  const real = audioPath(corpusFile, id);
  if (fs.existsSync(real)) return { file: real, source: "reel" };
  const synth = synthPath(corpusFile, id);
  if (fs.existsSync(synth)) return { file: synth, source: "synth" };
  return null;
}

/**
 * What produced the synthetic clips, written beside them at synthesis time.
 *
 * Kept on disk rather than re-queried at report time because the answer must
 * describe the WAVs that are actually being measured: a voice installed (or
 * removed) after the fact would otherwise silently relabel old audio.
 */
interface SynthManifest {
  voice: string;
  culture: string;
  rate: number;
  generatedIso: string;
}

function manifestPath(corpusFile: string): string {
  return path.join(synthDir(corpusFile), "voix.json");
}

function readSynthManifest(corpusFile: string): SynthManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(corpusFile), "utf8")) as Partial<SynthManifest>;
    if (typeof raw.voice !== "string" || typeof raw.culture !== "string") return null;
    return {
      voice: raw.voice,
      culture: raw.culture,
      rate: typeof raw.rate === "number" ? raw.rate : 0,
      generatedIso: typeof raw.generatedIso === "string" ? raw.generatedIso : "?",
    };
  } catch {
    return null;
  }
}

/** True when the voice reads the corpus's own language. When it is FALSE the
 * synthetic number stops being a chain measurement and becomes a measurement of
 * a foreign accent, which the report has to say in as many words. */
function voiceMatchesCorpus(manifest: SynthManifest | null, language: string): boolean {
  if (!manifest) return false;
  return manifest.culture.toLowerCase().startsWith(language.toLowerCase().slice(0, 2));
}

// ---------------------------------------------------------------------------
// Reading whatever Roch recorded
// ---------------------------------------------------------------------------

/**
 * Any 16-bit PCM WAV in, 16 kHz mono Int16 out.
 *
 * shared/wav.ts's pcmFromWav is stricter on purpose (it guards an API contract
 * and throws on anything but 16 kHz mono), which is right for the app and wrong
 * here: a corpus that can only be recorded at exactly 16 kHz mono is a corpus
 * that never gets recorded. Every ordinary recorder writes 44.1 or 48 kHz
 * stereo.
 *
 * Down-mixing and resampling here does NOT flatter the engine: Flow's own
 * capture is a 16 kHz mono AudioWorklet, so this brings a file recorded at
 * 48 kHz CLOSER to what the app really sends, not further from it. And whatever
 * the conversion costs, it costs every configuration the same thing, so it
 * cannot bias a comparison - only, very slightly, an absolute number.
 */
function decodeWavTo16kMono(bytes: Uint8Array): Int16Array {
  if (bytes.length < 44) throw new Error("WAV too short");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id4 = (off: number) => String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (id4(0) !== "RIFF" || id4(8) !== "WAVE") throw new Error("not a WAV file");
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = id4(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      const format = v.getUint16(off + 8, true);
      channels = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
      // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (what several Windows
      // recorders emit for plain 16-bit PCM).
      if (format !== 1 && format !== 0xfffe) throw new Error(`unsupported WAV format tag ${format} (need 16-bit PCM)`);
      if (bits !== 16) throw new Error(`unsupported WAV bit depth ${bits} (need 16)`);
      if (channels < 1 || channels > 2) throw new Error(`unsupported channel count ${channels}`);
    } else if (id === "data") {
      if (!rate) throw new Error("WAV data chunk before fmt");
      const dataBytes = Math.min(size, bytes.length - off - 8);
      const frames = Math.floor(dataBytes / 2 / channels);
      const mono = new Int16Array(frames);
      for (let f = 0; f < frames; f++) {
        if (channels === 1) {
          mono[f] = v.getInt16(off + 8 + f * 2, true);
        } else {
          const l = v.getInt16(off + 8 + f * 4, true);
          const r = v.getInt16(off + 8 + f * 4 + 2, true);
          mono[f] = (l + r) >> 1;
        }
      }
      return rate === SAMPLE_RATE ? mono : resampleTo16k(mono, rate);
    }
    off += 8 + size + (size % 2); // RIFF chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}

/** Linear interpolation. Not a polyphase filter, and honest about it: at 48 ->
 * 16 kHz it can alias content above 8 kHz, which speech barely carries and
 * which whisper's own front end discards anyway. */
function resampleTo16k(pcm: Int16Array, fromRate: number): Int16Array {
  const ratio = fromRate / SAMPLE_RATE;
  const out = new Int16Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const a = Math.floor(at);
    const b = Math.min(a + 1, pcm.length - 1);
    const t = at - a;
    out[i] = Math.round(pcm[a] * (1 - t) + pcm[b] * t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** Markdown pipe tables, padded. Readable straight in the terminal AND valid
 * markdown when pasted into a note - the two things the report has to be. */
function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => "| " + cells.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |";
  console.log(line(headers));
  console.log("| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |");
  for (const r of rows) console.log(line(r));
}

function pct(x: number | null): string {
  return x === null ? "n/a" : (x * 100).toFixed(1) + " %";
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const at = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[at];
}

/** The audio source, compact enough to sit in a table column. It is a COLUMN
 * and not a footnote because tables get copied out of terminals one row at a
 * time, and a WER without its source is not a result. */
function sourceLabel(measured: readonly Measured[]): string {
  const reel = measured.filter((m) => m.source === "reel").length;
  const synth = measured.length - reel;
  if (synth === 0) return `réel ${reel}`;
  if (reel === 0) return `synthèse ${synth}`;
  return `réel ${reel} + synth ${synth}`;
}

// ---------------------------------------------------------------------------
// One measured utterance
// ---------------------------------------------------------------------------

interface Measured {
  utterance: CorpusUtterance;
  hypothesis: string;
  ms: number;
  /** Which voice this particular clip came from. Per utterance, because a
   * partially recorded corpus mixes the two. */
  source: AudioSource;
  folded: WerResult;
  strict: WerResult;
  termsHit: number;
  termsTotal: number;
  /** The VAD refused the clip: nothing was ever sent to the model. Counted as a
   * total failure of that utterance (empty hypothesis), and flagged, because
   * "Flow said nothing" is the worst outcome a dictation can have and must
   * never be quietly excluded from an average. */
  gated: boolean;
}

interface ConfigResult {
  label: string;
  model: string;
  dict: boolean;
  measured: Measured[];
  folded: WerTotals;
  strict: WerTotals;
  termsHit: number;
  termsTotal: number;
  latencies: number[];
  backend: string;
}

async function runConfig(
  corpus: Corpus,
  corpusFile: string,
  present: CorpusUtterance[],
  model: string,
  dict: boolean,
): Promise<ConfigResult> {
  const entries = corpusEntries(corpus);
  const compiled = compileDictionary(entries);
  const sc = new WhisperSidecar({
    binaryPaths: BINS,
    modelPath: modelPath(model),
    language: LANGUAGE,
    beamSize: BEAM_SIZE,
    // Storey 1 exactly as index.ts builds it: the French seed, plus the starred
    // terms when the dictionary is on. With it off, the seed alone - byte for
    // byte what Flow sent before the dictionary existed.
    initialPrompt: dict ? buildDictationPrompt(FRENCH_PROMPT, entries) : FRENCH_PROMPT,
  });
  await sc.ensureStarted();
  const measured: Measured[] = [];
  try {
    for (const u of present) {
      // present[] is built from the same resolver, so this cannot miss; the
      // guard keeps the type honest rather than asserting non-null.
      const found = resolveAudio(corpusFile, u.id);
      if (!found) continue;
      const pcm = decodeWavTo16kMono(new Uint8Array(fs.readFileSync(found.file)));
      // The production path, in production order (main/index.ts's
      // processUtterance): VAD gate -> trim -> model -> hallucination gate ->
      // storey 2. Any step skipped here would measure something the user never
      // gets.
      const speech = analyzeSpeech(pcm);
      let hypothesis = "";
      let ms = 0;
      let gated = false;
      if (!hasSpeech(speech)) {
        gated = true;
      } else {
        const r = await sc.transcribe(encodeWav(trimToSpeech(pcm, speech)));
        ms = r.ms;
        const clean = gateTranscript(r.text) ?? "";
        hypothesis = dict ? applyDictionary(clean, compiled) : clean;
      }
      const t = termHits(hypothesis, u.terms ?? []);
      measured.push({
        utterance: u,
        hypothesis,
        ms,
        gated,
        source: found.source,
        folded: wordErrorRate(u.text, hypothesis, "folded"),
        strict: wordErrorRate(u.text, hypothesis, "strict"),
        termsHit: t.hit.length,
        termsTotal: (u.terms ?? []).length,
      });
      process.stdout.write(".");
    }
  } finally {
    sc.stop();
  }
  process.stdout.write("\n");
  return {
    label: `${model.replace(/^ggml-|\.bin$/g, "")} | dict ${dict ? "on" : "off"}`,
    model,
    dict,
    measured,
    folded: aggregateWer(measured.map((m) => m.folded)),
    strict: aggregateWer(measured.map((m) => m.strict)),
    termsHit: measured.reduce((n, m) => n + m.termsHit, 0),
    termsTotal: measured.reduce((n, m) => n + m.termsTotal, 0),
    latencies: measured.filter((m) => !m.gated).map((m) => m.ms),
    backend: path.basename(sc.activeBackend()) || "(none)",
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function report(corpus: Corpus, corpusFile: string, present: CorpusUtterance[], configs: ConfigResult[]): void {
  const threads = Math.max(1, Math.min(8, os.cpus().length - 1));
  const measuredAll = configs[0]?.measured ?? [];
  const synthCount = measuredAll.filter((m) => m.source === "synth").length;
  const manifest = readSynthManifest(corpusFile);
  const foreignVoice = synthCount > 0 && !voiceMatchesCorpus(manifest, corpus.language);

  console.log("\n# Banc WER français - Flow\n");
  console.log(`- corpus : \`${path.relative(process.cwd(), corpusFile)}\` - ${present.length} énoncés mesurés sur ${corpus.utterances.length}`);
  console.log(`- source audio : **${sourceLabel(measuredAll)}**`);
  if (synthCount > 0) {
    console.log(
      `- voix de synthèse : ${manifest ? `${manifest.voice} (${manifest.culture}), débit ${manifest.rate}, générée le ${manifest.generatedIso}` : "inconnue (manifeste absent)"}`,
    );
  }
  console.log(`- moteur : ${configs[0]?.backend ?? "?"}, langue \`${LANGUAGE}\`, beam-size ${BEAM_SIZE}, ~${threads} threads`);
  console.log(`- amorce : \`${FRENCH_PROMPT}\``);
  console.log(`- dictionnaire du banc : ${corpus.dictionary.length} entrées, définies DANS le corpus (jamais ~/.flow)`);
  console.log(`- date : ${new Date().toISOString()}`);

  // The synthesis caveat is printed BEFORE the numbers, not after: a reader who
  // stops at the first table must still have met it. (Requirement of C8: the
  // mention travels with the figure, otherwise the figure becomes a lie the day
  // someone quotes it out of context.)
  if (synthCount > 0) {
    console.log(
      `\n> **Ces chiffres viennent d'une voix de synthèse${foreignVoice ? " ÉTRANGÈRE À LA LANGUE DU CORPUS" : ""}, pas de vraie parole.**\n` +
        "> Ils mesurent la CHAÎNE DE TRAITEMENT - modèle, amorce, dictionnaire, normalisation - et\n" +
        "> rien d'autre : pas d'accent québécois, pas d'hésitation, pas de bruit de pièce, pas de micro.\n" +
        (foreignVoice
          ? `> Pire ici : la voix lit du ${corpus.language} avec la phonétique de ${manifest?.culture ?? "?"}, donc le WER\n` +
            "> absolu mesure surtout cet accent. Il reste valable en A/B (l'audio est identique d'une\n" +
            "> configuration à l'autre), jamais comme estimation de ce que Roch va vivre.\n"
          : "") +
        "> La ligne de base en conditions réelles s'obtient avec `npm run bench:wer -- --record`.",
    );
  }
  console.log("");

  console.log("## Configurations\n");
  printTable(
    ["configuration", "audio", "WER", "WER strict", "termes exacts", "médiane (ms)", "p95 (ms)", "mots réf.", "S", "I", "D"],
    configs.map((c) => {
      const sorted = c.latencies.slice().sort((a, b) => a - b);
      return [
        c.label,
        sourceLabel(c.measured),
        pct(c.folded.wer),
        pct(c.strict.wer),
        c.termsTotal ? `${c.termsHit}/${c.termsTotal}` : "-",
        String(percentile(sorted, 0.5) ?? "-"),
        String(percentile(sorted, 0.95) ?? "-"),
        String(c.folded.refWords),
        String(c.folded.substitutions),
        String(c.folded.insertions),
        String(c.folded.deletions),
      ];
    }),
  );

  // The rest of the report reads the FIRST configuration: it is the reference
  // line every later wave compares against, and printing four per-utterance
  // tables would bury it.
  const ref = configs[0];
  if (!ref) return;
  console.log(`\n## Par catégorie - ${ref.label}\n`);
  const cats = new Map<string, Measured[]>();
  for (const m of ref.measured) {
    for (const c of m.utterance.categories ?? ["(sans catégorie)"]) {
      const list = cats.get(c) ?? [];
      list.push(m);
      cats.set(c, list);
    }
  }
  printTable(
    ["catégorie", "n", "WER", "WER strict", "mots réf.", "erreurs"],
    [...cats.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, list]) => {
        const f = aggregateWer(list.map((m) => m.folded));
        const s = aggregateWer(list.map((m) => m.strict));
        return [name, String(list.length), pct(f.wer), pct(s.wer), String(f.refWords), String(f.errors)];
      }),
  );

  console.log(`\n## Par énoncé - ${ref.label}\n`);
  printTable(
    ["id", "audio", "WER", "S", "I", "D", "ms", "transcription"],
    ref.measured.map((m) => [
      m.utterance.id,
      m.source === "reel" ? "réel" : "synth",
      m.gated ? "VAD" : pct(m.folded.wer),
      String(m.folded.substitutions),
      String(m.folded.insertions),
      String(m.folded.deletions),
      m.gated ? "-" : String(m.ms),
      m.gated ? "(refusé par le VAD : aucun son de parole)" : m.hypothesis.replace(/\s+/g, " ").slice(0, 90),
    ]),
  );

  const subs = new Map<string, number>();
  for (const m of ref.measured) {
    for (const s of m.folded.alignment.substitutions) {
      const k = `${s.ref} -> ${s.hyp}`;
      subs.set(k, (subs.get(k) ?? 0) + 1);
    }
  }
  const top = [...subs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length) {
    console.log(`\n## Substitutions les plus fréquentes - ${ref.label}\n`);
    printTable(["référence -> transcrit", "n"], top.map(([k, n]) => [k, String(n)]));
  }

  console.log(
    "\n## Ce que ce tableau ne prouve pas\n\n" +
      (synthCount > 0
        ? `- **${synthCount} énoncés sur ${measuredAll.length} viennent d'une voix de synthèse${foreignVoice ? ` en ${manifest?.culture ?? "?"}` : ""}.** Ce n'est\n` +
          "  PAS de la parole : la chaîne est mesurée, l'usage réel ne l'est pas. Un chiffre cité sans\n" +
          "  cette phrase est un chiffre faux.\n"
        : "") +
      `- ${present.length} énoncés, une voix, un micro, une pièce. Aucun intervalle de confiance sérieux : un écart\n` +
      "  de quelques points entre deux configurations peut n'être que du bruit. Voir le protocole (plan §4.2).\n" +
      "- La ponctuation n'est pas mesurée du tout, dans aucune des deux colonnes.\n" +
      "- « WER » plie la casse et les accents ; « WER strict » ne les plie pas. L'écart entre les deux EST\n" +
      "  le taux d'erreur de casse et d'accents.\n" +
      "- Les « termes exacts » sont la seule colonne où le dictionnaire peut vraiment se voir : son effet\n" +
      "  porte sur deux ou trois mots par phrase, ce que le WER dilue presque entièrement.\n",
  );
}

// ---------------------------------------------------------------------------
// Speaking the corpus (`--synthesize`)
// ---------------------------------------------------------------------------

/**
 * Windows' own offline speech synthesis, through System.Speech - the SAME
 * mechanism scripts/bench-latency.ts has used since v5 to feed the sidecar, so
 * this adds no dependency and no second way of doing one thing. It writes
 * straight to 16 kHz mono 16-bit PCM, the format the pipeline wants.
 *
 * Rate 0 is the voice's default pace and is RECORDED IN THE MANIFEST rather
 * than left implicit: speaking rate changes the WER, so a run that compared a
 * fast corpus against a slow one would report a model regression that is really
 * a synthesis setting.
 */
const SYNTH_RATE = 0;

/** Single-quoted PowerShell literal: the only escape inside one is '' for '. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

interface InstalledVoice {
  name: string;
  culture: string;
}

function listVoices(): InstalledVoice[] {
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {",
    "  [Console]::Out.WriteLine($_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name) };",
    "$s.Dispose();",
  ].join(" ");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.lastIndexOf("|");
      return { name: l.slice(0, at), culture: l.slice(at + 1) };
    })
    .filter((v) => v.name && v.culture);
}

/** A voice of the corpus's language if the machine has one, otherwise the first
 * installed voice. The fallback is deliberate and loud rather than fatal: a
 * foreign-accent run is still a usable A/B instrument (the audio is identical
 * across configurations), and refusing to run at all would leave the bench with
 * no reproducible source whatsoever. The report never lets the distinction
 * out of its sight. */
function pickVoice(voices: readonly InstalledVoice[], language: string): InstalledVoice | null {
  const want = language.toLowerCase().slice(0, 2);
  return voices.find((v) => v.culture.toLowerCase().startsWith(want)) ?? voices[0] ?? null;
}

function synthesizeBatch(jobs: ReadonlyArray<{ id: string; text: string; file: string }>, voice: string): void {
  // The utterances travel through a UTF-8 JSON file, never the command line:
  // this corpus is French and the accents ARE the measurement. A command line
  // crosses the console code page on the way into PowerShell, where "réévalué"
  // can arrive mangled - and a mangled reference would score every engine as
  // broken.
  const jobFile = path.join(os.tmpdir(), `flow-wer-synth-${process.pid}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(jobs), "utf8");
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Speech;",
    `$jobs = [System.IO.File]::ReadAllText(${psQuote(jobFile)}, [System.Text.Encoding]::UTF8) | ConvertFrom-Json;`,
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    `$s.SelectVoice(${psQuote(voice)});`,
    `$s.Rate = ${SYNTH_RATE};`,
    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000," +
      " [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen," +
      " [System.Speech.AudioFormat.AudioChannel]::Mono);",
    "foreach ($j in $jobs) {",
    "  $s.SetOutputToWaveFile($j.file, $f);",
    "  $s.Speak($j.text);",
    "  [Console]::Out.WriteLine('OK ' + $j.id) };",
    "$s.SetOutputToNull(); $s.Dispose();",
  ].join(" ");
  try {
    // One process for the whole corpus, not one per utterance: loading
    // System.Speech costs about a second, and paying it 24 times turns a
    // 30-second job into a coffee break.
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 10 * 60_000,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } finally {
    try {
      fs.unlinkSync(jobFile);
    } catch {
      /* best effort: a stale temp file is not worth failing a bench over */
    }
  }
}

function synthesizeCorpus(corpus: Corpus, corpusFile: string, only: Set<string>, force: boolean): void {
  if (process.platform !== "win32") {
    console.error("--synthesize utilise System.Speech (Windows). Sur un autre système, enregistre avec --record.");
    process.exitCode = 1;
    return;
  }
  const voices = listVoices();
  if (voices.length === 0) {
    console.error("Aucune voix de synthèse installée sur cette machine.");
    process.exitCode = 1;
    return;
  }
  const voice = pickVoice(voices, corpus.language);
  if (!voice) {
    console.error("Aucune voix utilisable.");
    process.exitCode = 1;
    return;
  }
  const dir = synthDir(corpusFile);
  fs.mkdirSync(dir, { recursive: true });
  const todo = corpus.utterances
    .filter((u) => (only.size === 0 || only.has(u.id)) && (force || !fs.existsSync(synthPath(corpusFile, u.id))))
    .map((u) => ({ id: u.id, text: u.text, file: synthPath(corpusFile, u.id) }));

  console.log(`\nVoix installées : ${voices.map((v) => `${v.name} (${v.culture})`).join(", ")}`);
  console.log(`Voix retenue    : ${voice.name} (${voice.culture}), débit ${SYNTH_RATE}`);
  if (!voice.culture.toLowerCase().startsWith(corpus.language.slice(0, 2))) {
    console.log(
      `\n  ATTENTION : cette voix n'est PAS en ${corpus.language}. Elle va lire du français avec\n` +
        `  la phonétique de ${voice.culture}. Le WER obtenu mesurera surtout cet accent, et il ne\n` +
        `  faut PAS le lire comme la qualité de Flow. Il reste utilisable en A/B (l'audio est\n` +
        `  identique d'une configuration à l'autre). Pour une vraie ligne de base, --record.\n\n` +
        `  Pour installer une voix française (PowerShell administrateur, redémarrage requis) :\n` +
        `    Add-WindowsCapability -Online -Name Language.TextToSpeech~~~fr-CA~0.0.1.0\n`,
    );
  }
  if (todo.length === 0) {
    console.log("\nTous les fichiers existent déjà (--force pour les refaire).\n");
    return;
  }
  console.log(`\nSynthèse de ${todo.length} énoncé(s) vers ${path.relative(process.cwd(), dir)}\n`);
  synthesizeBatch(todo, voice.name);
  const manifest: SynthManifest = {
    voice: voice.name,
    culture: voice.culture,
    rate: SYNTH_RATE,
    generatedIso: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath(corpusFile), JSON.stringify(manifest, null, 2), "utf8");
  const done = corpus.utterances.filter((u) => fs.existsSync(synthPath(corpusFile, u.id))).length;
  console.log(`\n${done}/${corpus.utterances.length} énoncés synthétisés. Mesure : npm run bench:wer\n`);
}

// ---------------------------------------------------------------------------
// Recording the corpus (`--record`)
// ---------------------------------------------------------------------------

/**
 * Windows' own MCI waveaudio device, reached through winmm.dll. No new
 * dependency, no ffmpeg, no native module: it records straight to a 16 kHz mono
 * 16-bit WAV, which is exactly the format the pipeline wants and the same one
 * Flow's AudioWorklet produces. One PowerShell process per utterance, stopped
 * by a newline on its stdin so Roch controls the length from here.
 */
// The destination is BAKED INTO the script rather than passed as an argument:
// `powershell -Command <script> <arg>` does NOT populate $args - it appends the
// extra token to the command text and tries to execute it. An earlier draft of
// this file read `$dest = $args[0]`, which left $dest empty and made every
// recording fail at the save step with a path of "".
const PS_RECORD = (dest: string) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
using System.Text;
public static class Mci {
  [DllImport("winmm.dll", CharSet=CharSet.Auto)]
  public static extern int mciSendString(string cmd, StringBuilder ret, int len, System.IntPtr hwnd);
}
"@
$sb = New-Object System.Text.StringBuilder 512
function M([string]$c) { return [Mci]::mciSendString($c, $sb, $sb.Capacity, [System.IntPtr]::Zero) }
$dest = ${psQuote(dest)}
if ((M 'open new type waveaudio alias flowrec') -ne 0) { Write-Output 'ERR open'; exit 1 }
[void](M 'set flowrec time format ms bitspersample 16 channels 1 samplespersec 16000 alignment 2 bytespersec 32000')
if ((M 'record flowrec') -ne 0) { [void](M 'close flowrec'); Write-Output 'ERR record'; exit 1 }
Write-Output 'RECORDING'
[void][System.Console]::In.ReadLine()
[void](M 'stop flowrec')
$r = M ('save flowrec "' + $dest + '"')
[void](M 'close flowrec')
if ($r -ne 0) { Write-Output ('ERR save ' + $r); exit 1 }
Write-Output 'SAVED'
`;

function recordOne(dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", PS_RECORD(dest)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let started = false;
    let stopping = false;
    const rl = readline.createInterface({ input: process.stdin });
    const finish = (err?: Error) => {
      rl.close();
      if (err) reject(err);
      else resolve();
    };
    ps.stdout.on("data", (d: Buffer) => {
      out += String(d);
      if (!started && out.includes("RECORDING")) {
        started = true;
        process.stdout.write("   [enregistrement...] Entrée pour arrêter ");
      }
    });
    ps.stderr.on("data", (d: Buffer) => (out += String(d)));
    rl.on("line", () => {
      if (stopping) return;
      stopping = true;
      ps.stdin.write("\n");
      ps.stdin.end();
    });
    ps.on("error", finish);
    ps.on("exit", (code) => {
      if (code === 0 && out.includes("SAVED")) return finish();
      finish(new Error(`l'enregistrement a échoué (${out.trim().split("\n").pop() ?? `code ${code}`})`));
    });
  });
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function recordCorpus(corpus: Corpus, corpusFile: string, only: Set<string>, force: boolean): Promise<void> {
  if (process.platform !== "win32") {
    console.error("--record utilise l'API MCI de Windows; sur un autre système, enregistre les WAV à la main.");
    process.exitCode = 1;
    return;
  }
  const dir = audioDir(corpusFile);
  fs.mkdirSync(dir, { recursive: true });
  const todo = corpus.utterances.filter(
    (u) => (only.size === 0 || only.has(u.id)) && (force || !fs.existsSync(audioPath(corpusFile, u.id))),
  );
  console.log(
    `\nEnregistrement du corpus - ${todo.length} énoncé(s) à faire, dans ${path.relative(process.cwd(), dir)}\n\n` +
      "Lis chaque phrase telle qu'elle est écrite, d'une traite, au rythme d'une vraie dictée.\n" +
      "Entrée = démarrer, Entrée = arrêter, `s` + Entrée = passer, `q` + Entrée = quitter.\n" +
      "Les fichiers déjà enregistrés sont sautés (--force pour les refaire).\n",
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, u] of todo.entries()) {
      console.log(`\n[${i + 1}/${todo.length}] ${u.id}  (${(u.categories ?? []).join(", ")})`);
      console.log(`   « ${u.text} »`);
      const answer = (await ask(rl, "   Entrée pour enregistrer > ")).trim().toLowerCase();
      if (answer === "q") break;
      if (answer === "s") continue;
      rl.pause();
      try {
        await recordOne(audioPath(corpusFile, u.id));
        console.log("\n   enregistré.");
      } catch (e) {
        console.log(`\n   ${e instanceof Error ? e.message : String(e)}`);
      }
      rl.resume();
    }
  } finally {
    rl.close();
  }
  const done = corpus.utterances.filter((u) => fs.existsSync(audioPath(corpusFile, u.id))).length;
  console.log(`\n${done}/${corpus.utterances.length} énoncés ont maintenant un enregistrement. Mesure : npm run bench:wer\n`);
}

// ---------------------------------------------------------------------------

const HELP_NO_AUDIO = (corpusFile: string) =>
  `Le corpus n'a AUCUN audio, donc il n'y a pas de WER à mesurer.\n\n` +
  `C'est l'état livré : le dépôt versionne les TEXTES, jamais le son. Deux façons de lui\n` +
  `donner une voix, et elles ne mesurent pas la même chose.\n\n` +
  `1. SYNTHÈSE - une minute, reproductible, disponible tout de suite :\n\n` +
  `     npm run bench:wer -- --synthesize\n\n` +
  `   Windows lit les 24 énoncés (System.Speech, hors ligne, aucune dépendance) vers\n` +
  `   ${path.relative(process.cwd(), synthDir(corpusFile))}\\<id>.wav.\n` +
  `   Ça mesure la CHAÎNE (modèle, amorce, dictionnaire, normalisation), PAS de la vraie\n` +
  `   parole : ni accent québécois, ni hésitation, ni bruit de pièce, ni micro. Le banc\n` +
  `   étiquette chacun de ses tableaux en conséquence.\n\n` +
  `2. TA VOIX - vingt minutes, une seule fois, et c'est la seule vraie ligne de base :\n\n` +
  `     npm run bench:wer -- --record\n\n` +
  `   Il affiche chaque phrase, enregistre au micro par défaut (16 kHz mono, API Windows)\n` +
  `   et dépose ${path.relative(process.cwd(), audioDir(corpusFile))}\\<id>.wav.\n\n` +
  `Les deux dossiers sont dans .gitignore : le dépôt est public, la voix reste sur la machine.\n` +
  `Le banc préfère AUTOMATIQUEMENT l'enregistrement réel quand il en trouve un, énoncé par\n` +
  `énoncé - tu peux donc enregistrer en plusieurs fois sans rien reconfigurer.\n\n` +
  `Puis :  npm run bench:wer\n`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return null;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
  };
  const corpusFile = flag("corpus") || CORPUS_DEFAULT;
  const corpus = loadCorpus(corpusFile);
  const only = new Set((flag("only") || "").split(",").filter(Boolean));

  if (flag("record") !== null) {
    await recordCorpus(corpus, corpusFile, only, flag("force") !== null);
    return;
  }
  if (flag("synthesize") !== null || flag("synth") !== null) {
    synthesizeCorpus(corpus, corpusFile, only, flag("force") !== null);
    return;
  }

  const present = corpus.utterances.filter(
    (u) => (only.size === 0 || only.has(u.id)) && resolveAudio(corpusFile, u.id) !== null,
  );
  if (present.length === 0) {
    console.error(HELP_NO_AUDIO(corpusFile));
    process.exitCode = 1;
    return;
  }

  const wanted = (flag("models") || DEFAULT_MODEL_FILE).split(",").filter(Boolean);
  const models = wanted.filter((m) => {
    if (fs.existsSync(modelPath(m))) return true;
    console.error(`modèle absent, ignoré : ${m}`);
    return false;
  });
  if (models.length === 0) {
    console.error(
      `Aucun des modèles demandés n'est présent dans ${modelsDir()}.\n` +
        `Modèles connus : ${AVAILABLE_MODELS.map((m) => m.file).join(", ")}\n` +
        `Le banc ne télécharge JAMAIS : lance Flow une fois avec le modèle voulu, ou copie le .bin.`,
    );
    process.exitCode = 1;
    return;
  }
  const dictModes = (flag("dict") || "on,off").split(",").map((s) => s.trim() === "on");

  const configs: ConfigResult[] = [];
  for (const model of models) {
    for (const dict of dictModes) {
      process.stdout.write(`${model} | dict ${dict ? "on " : "off"} `);
      configs.push(await runConfig(corpus, corpusFile, present, model, dict));
    }
  }
  report(corpus, corpusFile, present, configs);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
