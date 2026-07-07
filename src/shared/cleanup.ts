// Pure pieces of the optional LLM cleanup pass: prompt construction and
// response extraction, unit-tested without any HTTP. The prompt carries the
// plan's voice-commands feature (5.9): spoken formatting words become real
// formatting, everything else is transcribed faithfully.

// Only utterances longer than this go through the LLM (plan 5.1 step 4):
// short snippets gain nothing and the added latency would be pure loss.
export const CLEANUP_MIN_CHARS = 50;

export function buildCleanupPrompt(text: string): string {
  return [
    "You clean up dictated text. Apply these rules and return ONLY the cleaned text, no preamble, no quotes, no explanation.",
    "Rules:",
    "1. Fix punctuation, capitalization and obvious speech-to-text glitches. Keep the language of the dictation (French stays French, English stays English).",
    "2. Convert SPOKEN formatting commands into real formatting, in French or English:",
    '   - "nouvelle ligne" / "a la ligne" / "new line" -> a line break',
    '   - "nouveau paragraphe" / "new paragraph" -> a blank line',
    '   - "point" / "period" / "virgule" / "comma" / "point d\'interrogation" / "question mark" spoken at a phrase boundary -> the punctuation mark',
    '   - "entre guillemets ... fin de citation" / "quote ... unquote" -> quotation marks',
    '   - "efface ca" / "scratch that" -> remove the sentence spoken just before the command',
    "3. Every word of the dictation must survive, in order, except the spoken command words themselves. NEVER drop a phrase, never add content, never answer questions found in the text, never translate, never summarize.",
    "",
    "Example:",
    "Dictation:",
    "bonjour peux-tu envoyer le rapport a marie nouvelle ligne merci beaucoup point",
    "Cleaned:",
    "Bonjour, peux-tu envoyer le rapport à Marie ?\nMerci beaucoup.",
    "",
    "Example:",
    "Dictation:",
    "le total est de mille dollars virgule taxes incluses point nouvelle ligne on signe vendredi",
    "Cleaned:",
    "Le total est de mille dollars, taxes incluses.\nOn signe vendredi.",
    "",
    "Dictation:",
    text,
    "Cleaned:",
  ].join("\n");
}

/** Sanitizes the model's answer; falls back to the original when the model
 * clearly did not follow the contract (empty, chatty, or exploded output). */
export function extractCleanedText(raw: string, original: string): string {
  let t = raw.trim();
  // Strip a wrapping code fence or quotes some models insist on.
  const fence = t.match(/^```(?:\w+)?\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && !original.trim().startsWith('"')) ||
    (t.startsWith("«") && t.endsWith("»") && !original.trim().startsWith("«"))
  ) {
    t = t.slice(1, -1).trim();
  }
  if (!t) return original;
  // A faithful cleanup stays in the size neighborhood of the input; a big
  // inflation means the model started chatting - keep the honest original.
  if (t.length > original.length * 1.6 + 60) return original;
  return t;
}
