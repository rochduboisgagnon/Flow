// Last line of the anti-hallucination defense (plan 5.9): even past the VAD
// and the model's own no-speech scoring, Whisper trained on YouTube emits a
// well-known family of phantom strings on near-silence ("Sous-titres realises
// par la communaute d'Amara.org", "Thank you for watching", "[BLANK_AUDIO]").
// Those exact strings are never legitimate dictation: drop them.
//
// The list is deliberately SHORT and surgical - the VAD is the real gate; this
// only catches the classics. A plain "merci" or "thank you" passes: people
// dictate those.

const EXACT: ReadonlySet<string> = new Set(
  [
    "merci d avoir regarde cette video",
    "merci d avoir regarde la video",
    "merci d avoir regarde",
    "merci de vous abonner",
    "n oubliez pas de vous abonner",
    "abonnez vous",
    "thank you for watching",
    "thanks for watching",
    "please subscribe",
    "don t forget to subscribe",
    "sous titrage societe radio canada",
    "sous titrage st 501",
    "untertitelung des zdf fur funk 2017",
    "untertitelung des zdf fur funk 2018",
  ].map((s) => s), // already normalized
);

/** Lowercase, strip diacritics, keep [a-z0-9] as words, collapse spaces. */
export function normalizeForGate(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Entirely bracketed/starred = a sound tag, not words: "[BLANK_AUDIO]",
  // "[Musique]", "(bruit de fond)", "*rires*", "♪ ... ♪".
  if (/^[([{*♪♫].*[)\]}*♪♫]$/s.test(t)) return true;
  const n = normalizeForGate(t);
  if (!n) return true; // only punctuation / symbols
  if (EXACT.has(n)) return true;
  // Any Amara credit variant, all languages ("... la communaute d'Amara.org").
  if (n.includes("amara org")) return true;
  return false;
}

/** Returns the text to insert, or null when nothing must be inserted. */
export function gateTranscript(text: string): string | null {
  const t = text.trim();
  return isHallucination(t) ? null : t;
}
