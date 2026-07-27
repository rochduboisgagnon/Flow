// U3a: the sanitizer for user-written snippet HTML. This is a SECURITY
// BOUNDARY, not a formatting helper. Read the four decisions below before
// changing a single line of it.
//
// ---------------------------------------------------------------------------
// WHERE IT RUNS, AND WHY THERE
// ---------------------------------------------------------------------------
// In the MAIN process, on WRITE, before the snippet bytes ever reach the disk.
// The file on disk has to be safe for EVERY future consumer - the local HTTP
// API, an MCP reader, a backup someone opens in a browser - not just for the
// React component that renders it today. Sanitizing on read, in the renderer,
// would leave a hostile file sitting on disk for whoever reads it next, and it
// would have to be re-done, identically, in every reader ever written.
//
// The module is PURE: no electron import, no DOM. That is a requirement, not a
// preference. The main process has no DOM to parse HTML with, so the tokenizer
// below is hand-written; being pure is also what lets `node --test` exercise
// the whole boundary without an app instance.
//
// Today the renderer has contextIsolation:true but sandbox:false, and there is
// no CSP yet (that lands in U3f). Until then this allowlist is the ONLY wall.
//
// ---------------------------------------------------------------------------
// DECISION 1 - HOW WE PARSE (and why a regex alone would be indefensible)
// ---------------------------------------------------------------------------
// In three sentences: a hand-written, single-pass, iterative tokenizer walks
// the input, modelled on the HTML5 tokenizer for exactly the states that decide
// where markup begins and ends (tag open, attribute names and quoting,
// comments, bogus comments, RAWTEXT elements); nothing from the input is ever
// copied through as markup, because every kept element is RE-SERIALIZED from
// its token (`<b>`, `<br />`, `<a href="...">`) and every text run is
// re-escaped; therefore the output can only contain bytes this file chose to
// write, and the allowlist is enforced on a parsed token rather than on a
// pattern spotted in a string.
//
// That re-serialization is the whole security argument, and it is why a
// "strip the bad things with a regex" filter is not what we do. A subtractive
// filter has to be right about every byte it LEAVES BEHIND, and browsers have
// two decades of parse quirks (`<img/src=x`, `<a href=java&#115;cript:>`,
// `<svg><script>`) that make a leftover byte mean something different to the
// parser than it meant to the filter. An additive filter only has to be right
// about what it WRITES. The only attacker-influenced bytes in our output are
// (a) text, with `& < >` escaped, and (b) one href value, with `& < > " ' \``
// escaped inside double quotes. Neither can open a tag or close an attribute,
// so no downstream parser - however quirky - can find markup we did not intend.
//
// Limits of a hand-written tokenizer, honestly: it implements the HTML5
// TOKENIZER faithfully enough for the states listed above, but only a small,
// documented subset of HTML5 TREE CONSTRUCTION (see DECISION 3). A browser may
// therefore nest our output slightly differently than we did. That costs
// structure, never safety: whatever the re-parse produces, it can only contain
// allowlisted elements, at most one validated href, and escaped text.
//
// ---------------------------------------------------------------------------
// DECISION 2 - ENTITIES AND TEXT (the output must not re-parse into something
// else on a second reading)
// ---------------------------------------------------------------------------
// Text is DECODED then RE-ESCAPED, never passed through. Decoding first is what
// makes the function a fixed point: if we merely escaped, `&lt;` would become
// `&amp;lt;`, then `&amp;amp;lt;`, growing on every pass and drifting away from
// what the user wrote. Decoding turns `&lt;` back into `<` and re-escaping
// writes `&lt;` again - the same bytes, forever.
//
// A named entity we do not know (`&eacute;`, `&hellip;`) is kept VERBATIM
// rather than escaped, so typography and accents survive instead of turning
// into visible `&amp;eacute;`. That is safe because every HTML5 entity name
// that resolves to `<`, `>`, `&`, `"` or `'` is in TEXT_ENTITIES below - every
// other name resolves to a character that cannot start markup - and it is also
// a fixed point (an untouched `&eacute;` stays `&eacute;`).
//
// In an href the decoding is deliberately AGGRESSIVE, because there the
// decoded string is what a browser would navigate to: `java&#115;cript:` is
// `javascript:`. Over-decoding an href can only cause a REFUSAL (an allowlisted
// scheme never contains an entity), so erring toward more decoding is the safe
// direction. An entity we cannot decode inside a scheme prefix leaves `&` and
// `;` there, which fails the scheme shape check, which refuses the href. The
// completeness of ATTR_ENTITIES is therefore a fidelity concern, never a
// security one.
//
// ---------------------------------------------------------------------------
// DECISION 3 - IDEMPOTENCE: sanitize(sanitize(x)) === sanitize(x)
// ---------------------------------------------------------------------------
// This is the property that proves we never reintroduce anything, and it is
// tested. It holds because every stage is already a fixed point on its own
// output: text decodes/escapes back to itself (above); kept elements are
// re-serialized in one canonical form (`<b>`, `<br />`, `<a href="...">`) that
// the tokenizer reads back as the same token; the open-element stack is closed
// at EOF so the output is balanced, which means a second pass builds the same
// tree instead of repairing a different one; a refused href is gone, so there
// is nothing left to refuse; and dropped subtrees leave no residue to re-drop.
//
// The one caveat, stated rather than hidden: the input is truncated at
// MAX_SNIPPET_HTML_CHARS. Escaping can grow text up to ~5x (`&` -> `&amp;`), so
// an input that is both near the cap and almost entirely `&` can produce an
// output above the cap, which a second pass would truncate. Idempotence is
// guaranteed for every input at or under the cap - i.e. the entire realistic
// domain, since a snippet is a paragraph and the cap is 1 MiB.
//
// ---------------------------------------------------------------------------
// DECISION 4 - BOUNDS (no explosion, no unbounded recursion)
// ---------------------------------------------------------------------------
// The tokenizer is ITERATIVE - an explicit array is the element stack, there is
// no recursion anywhere - so hostile nesting cannot overflow the JS stack. The
// scan is strictly left-to-right and every branch advances the cursor (with a
// belt-and-braces guard in the attribute loop), so the work is linear in the
// input length.
//
// "Every branch advances the cursor" is necessary but NOT sufficient, and one
// branch proved it: a LOOK-AHEAD that scans past where the cursor will land is
// linear work per token, which is quadratic overall even though the cursor
// marches forward - and it hides well, because the input that triggers it is
// ORDINARY (a page of normal comments), not hostile. Every forward search in
// this file therefore has to stop inside the region the cursor is about to
// consume. See the comment branch, where looking for the two terminator forms
// separately cost 93 582 ms on 1 MiB of `<!---->` versus 6 ms for a single
// scan: whichever form the document does not use is the one whose search runs
// to the end of the input, once per comment.
//
// The regexes are flat alternations of character classes with no nested
// quantifiers, so none of them can backtrack catastrophically, and the only
// regex applied to a possibly-huge string (entity recognition) is a single
// global replace. Input is capped at 1 MiB and nesting at 64 levels; the first
// bounds the work, the second bounds what we hand to a downstream parser.

/**
 * Hard cap on the HTML we will look at. A snippet is a paragraph, not a
 * document: 1 MiB is already several hundred pages. Anything longer is
 * TRUNCATED here rather than rejected - truncation is safe because a cut tail
 * is just EOF to the tokenizer (an unterminated tag is dropped, open elements
 * are closed), whereas returning "" would silently destroy the user's snippet.
 */
export const MAX_SNIPPET_HTML_CHARS = 1_048_576;

/**
 * Deepest nesting of allowlisted elements we will emit. Past this, the tag is
 * dropped and its text keeps flowing (same treatment as a non-allowlisted
 * element). We have no recursion to protect, but the consumers of the stored
 * file do: `<b>` x 100000 is a valid, tiny string that has crashed more than
 * one recursive-descent HTML parser.
 */
export const MAX_NESTING_DEPTH = 64;

/** A scheme longer than this is not a scheme; bounds the scheme-shape check. */
const MAX_SCHEME_CHARS = 64;

/** Exhaustive. Anything not here loses its TAG but keeps its text content. */
export const SNIPPET_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "a",
  "br",
  "p",
  "ul",
  "ol",
  "li",
  "span",
]);

/** Allowlisted elements with no content: emitted self-closing, never stacked. */
const VOID_TAGS: ReadonlySet<string> = new Set(["br"]);

/**
 * These lose their tag AND their entire content. Keeping the text of a
 * `<script>` would paste executable source into the document as visible text,
 * and keeping the text of a `<style>` would leak selectors and `url()` calls
 * into the prose. `svg` and `math` are here because foreign content re-enables
 * a whole parallel parsing mode (`<svg><script>`, `<math><annotation-xml>`)
 * that our HTML-shaped tokenizer has no business trying to model.
 */
export const SNIPPET_DROPPED_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "svg",
  "math",
]);

/**
 * Dropped elements whose content is RAWTEXT (or script data) for a browser:
 * their content ends at the first `</name`, and `<` inside it never opens a
 * tag. Scanning them the same way is what keeps our idea of "where the script
 * ends" identical to the browser's - `<script>if (a<b) {}</script>` must not
 * make us hallucinate a `<b>` tag and then swallow the rest of the document.
 */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "iframe", "noscript"]);

/**
 * `embed` is VOID: there is no `</embed>` to wait for. Depth-counting it would
 * swallow everything to EOF, so we drop the tag alone and keep walking.
 */
const VOID_DROPPED_TAGS: ReadonlySet<string> = new Set(["embed"]);

/**
 * The dropped tags that are FOREIGN content, and the only ones for which a
 * trailing solidus really closes the element. HTML5 acknowledges the
 * self-closing flag on a foreign start tag (`<svg/>` inserts an empty SVG
 * element and the parser is back in HTML immediately), and IGNORES it on every
 * ordinary HTML element: `<script/>alert(1)</script>` is an open `script`
 * holding `alert(1)`, not an empty one. Treating that solidus as "no content
 * to skip" is a one-character bypass of the entire subtree drop - the payload
 * would come back out as visible text - so the trust in `selfClosing` stops
 * exactly where the browser's does.
 */
const FOREIGN_DROPPED_TAGS: ReadonlySet<string> = new Set(["svg", "math"]);

/** Whether a start tag for a dropped element genuinely has no content to skip. */
function isEmptyDroppedElement(tok: TagToken): boolean {
  return VOID_DROPPED_TAGS.has(tok.name) || (tok.selfClosing && FOREIGN_DROPPED_TAGS.has(tok.name));
}

/**
 * The only schemes an href may carry. No relative URLs: this app has no base
 * URL that would give them a meaning, so `/page` or `#anchor` resolves against
 * whatever document happens to embed the snippet - exactly the ambiguity a
 * stored file must not have.
 */
export const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"]);

/**
 * The complete set of HTML5 entity names that resolve to a character with
 * syntactic meaning. Anything outside this table cannot produce markup, which
 * is why unknown names are safe to keep verbatim.
 */
const TEXT_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/**
 * Extra names decoded inside an href. These are the ones that reassemble a
 * scheme out of harmless-looking pieces - `javascript&colon;alert(1)` is the
 * classic - plus the whitespace names browsers strip from URLs.
 */
const ATTR_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ...TEXT_ENTITIES,
  ["colon", ":"],
  ["tab", "\t"],
  ["newline", "\n"],
  ["semi", ";"],
  ["sol", "/"],
  ["num", "#"],
  ["quest", "?"],
  ["commat", "@"],
  ["period", "."],
  ["comma", ","],
  ["lpar", "("],
  ["rpar", ")"],
  ["equals", "="],
  ["excl", "!"],
  ["ast", "*"],
]);

// Hex before decimal (the decimal branch cannot match "&#x" anyway, but the
// order documents the intent). The named branch requires its semicolon: a
// semicolon-less `&amp` is left alone, which over-escapes it in text - safe -
// and refuses it in an href - also safe.
const ENTITY_RE = /&#[xX]([0-9a-fA-F]{1,6});?|&#([0-9]{1,7});?|&([a-zA-Z][a-zA-Z0-9]{0,30});/g;

// Same shape, plus the bare `& < >` that have to be escaped when no entity
// matched. One pass does decode + escape, so no intermediate string exists in
// which a decoded `<` could be mistaken for markup.
const TEXT_TOKEN_RE =
  /&#[xX]([0-9a-fA-F]{1,6});?|&#([0-9]{1,7});?|&([a-zA-Z][a-zA-Z0-9]{0,30});|[&<>]/g;

// C0 controls minus tab/LF/CR, plus DEL. A NUL in stored HTML truncates the
// file for any C consumer and is silently dropped by some parsers, which is a
// difference of opinion we do not want in a file we called safe. Matching
// control characters IS the job here; the lint rule below exists to catch the
// ones nobody meant to type.
// eslint-disable-next-line no-control-regex -- deliberate, see above.
const STRIPPED_CONTROLS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Everything a browser removes from a URL: tab, LF and CR are deleted anywhere,
// and leading/trailing controls are ignored. A filter that skips this step is
// bypassed by "java\tscript:" without any cleverness at all.
// eslint-disable-next-line no-control-regex -- see above: deliberate.
const URL_CONTROLS_RE = /[\u0000-\u001F\u007F]/g;

// What ends a comment: `-->`, or the `--!>` form a browser also accepts. A flat
// alternation over one optional character - nothing here can backtrack. It is
// module-level so it compiles once, and /g is what lets a scan START at the
// cursor (lastIndex, set explicitly before every use) instead of slicing a
// copy of the input for every comment.
const COMMENT_END_RE = /--!?>/g;

// A scheme is a letter followed by letters, digits, "+", "-", ".". Nothing
// else. This single test is also what refuses relative URLs: "//host", "/path",
// "?q=a:b" and "#a:b" all put a character in the prefix that a scheme cannot
// contain. The "-" is last so it needs no escape.
const SCHEME_SHAPE_RE = /^[a-z][a-z0-9+.-]*$/;

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
}

function isAsciiAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/** A decoded code point, or U+FFFD when it is not a character we may emit. */
function codePointToChar(n: number): string {
  // Lone surrogates, out-of-range values and NUL are what a browser turns into
  // U+FFFD; producing the same thing keeps our text identical to what a reader
  // would have seen anyway.
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(n);
}

/** Escape one decoded character for a text node; drop it if it is a control. */
function escapeTextChar(c: string): string {
  if (c === "&") return "&amp;";
  if (c === "<") return "&lt;";
  if (c === ">") return "&gt;";
  return c.replace(STRIPPED_CONTROLS_RE, "");
}

/**
 * Escape a plain string for use as HTML text. Exported because a caller that
 * builds a snippet from plain text (a paste, an import) needs the same
 * escaping, and a second implementation of it is a second thing to get wrong.
 *
 * Only `& < >` are escaped: that is exactly what HTML text needs. Quotes are
 * left readable on purpose - see the module note on what this does NOT cover.
 */
export function escapeHtmlText(s: string): string {
  return s.replace(STRIPPED_CONTROLS_RE, "").replace(/[&<>]/g, (m) => {
    return m === "&" ? "&amp;" : m === "<" ? "&lt;" : "&gt;";
  });
}

/** Escape a validated value for a double-quoted attribute. */
function escapeAttrValue(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "&") out += "&amp;";
    else if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === '"') out += "&quot;";
    else if (c === "'") out += "&#39;";
    // A backtick has no meaning in a quoted attribute for any current engine,
    // but old IE treated it as a delimiter. It costs one branch to make the
    // stored file independent of the consumer's parser generation.
    else if (c === "`") out += "&#96;";
    else out += c;
  }
  return out;
}

/** Decode + escape a source text run. */
function encodeTextNode(raw: string): string {
  // Controls are stripped BEFORE decoding as well as after (escapeTextChar
  // handles the decoded ones): a control written literally never goes through
  // the entity branch, so checking only decoded characters would let a raw NUL
  // straight into the stored file.
  return raw.replace(STRIPPED_CONTROLS_RE, "").replace(TEXT_TOKEN_RE, (m: string, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined) return escapeTextChar(codePointToChar(parseInt(hex, 16)));
    if (dec !== undefined) return escapeTextChar(codePointToChar(parseInt(dec, 10)));
    if (name !== undefined) {
      const decoded = TEXT_ENTITIES.get(name.toLowerCase());
      // Unknown name: keep it verbatim (see DECISION 2). It cannot be markup.
      return decoded === undefined ? m : escapeTextChar(decoded);
    }
    return m === "&" ? "&amp;" : m === "<" ? "&lt;" : "&gt;";
  });
}

/** Decode an attribute value the way a browser would before using it. */
function decodeAttrValue(raw: string): string {
  return raw.replace(ENTITY_RE, (m: string, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined) return codePointToChar(parseInt(hex, 16));
    if (dec !== undefined) return codePointToChar(parseInt(dec, 10));
    if (name !== undefined) {
      const decoded = ATTR_ENTITIES.get(name.toLowerCase());
      return decoded === undefined ? m : decoded;
    }
    return m;
  });
}

/**
 * The URL an `href` may keep, or null when it must be dropped.
 *
 * Exported for the tests and for any other place that ever has to accept a URL
 * from the user: the decode-then-clean-then-check order is the part that is
 * easy to get wrong, and it should exist once.
 */
export function sanitizeHref(raw: string): string | null {
  // Order matters. Decode first, because the attacker's payload is written in
  // entities precisely so that a check done before decoding sees something
  // harmless. Clean second, because the payload's other half is written in
  // control characters that a browser deletes and a naive check does not.
  const cleaned = decodeAttrValue(raw).replace(URL_CONTROLS_RE, "").trim();

  const colon = cleaned.indexOf(":");
  if (colon < 0 || colon > MAX_SCHEME_CHARS) return null;

  const scheme = cleaned.slice(0, colon).toLowerCase();
  if (!SCHEME_SHAPE_RE.test(scheme)) return null;
  if (!ALLOWED_URL_SCHEMES.has(scheme)) return null;

  // Return the CLEANED string, never the raw one: what we validated has to be
  // what we write, or the check applied to a different string than the reader
  // will see.
  return cleaned;
}

interface Attr {
  name: string;
  value: string;
}

interface TagToken {
  kind: "start" | "end";
  /** Lowercased. */
  name: string;
  attrs: Attr[];
  selfClosing: boolean;
  /** Index just past the ">". */
  end: number;
}

/**
 * Read one tag starting at `start`. Returns null on EOF inside the tag, which
 * is also what a browser does with it: the token is dropped entirely. Matching
 * that matters - `<a href=` at the end of a snippet must not become an anchor
 * for us and nothing for the reader, or vice versa.
 */
function readTag(src: string, start: number, kind: "start" | "end"): TagToken | null {
  let i = start + (kind === "end" ? 2 : 1);

  const nameStart = i;
  // Note that "<" does NOT end a tag name, for us as for the tokenizer: that is
  // why "<b<b<b..." reads as one absurd name and then dies at EOF instead of
  // producing a thousand tags.
  while (i < src.length && !isSpace(src.charAt(i)) && src.charAt(i) !== "/" && src.charAt(i) !== ">") {
    i++;
  }
  const name = src.slice(nameStart, i).toLowerCase();

  const attrs: Attr[] = [];
  let selfClosing = false;

  for (;;) {
    const iterStart = i;

    while (i < src.length && isSpace(src.charAt(i))) i++;
    if (i >= src.length) return null; // eof-in-tag
    const c = src.charAt(i);
    if (c === ">") {
      i++;
      break;
    }
    if (c === "/") {
      if (src.charAt(i + 1) === ">") {
        selfClosing = true;
        i += 2;
        break;
      }
      i++; // stray solidus between attributes: ignored, like the tokenizer does
      continue;
    }

    const nStart = i;
    while (
      i < src.length &&
      !isSpace(src.charAt(i)) &&
      src.charAt(i) !== "/" &&
      src.charAt(i) !== "=" &&
      src.charAt(i) !== ">"
    ) {
      i++;
    }
    const attrName = src.slice(nStart, i).toLowerCase();

    while (i < src.length && isSpace(src.charAt(i))) i++;

    let value = "";
    if (src.charAt(i) === "=") {
      i++;
      while (i < src.length && isSpace(src.charAt(i))) i++;
      const quote = src.charAt(i);
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1);
        if (close < 0) return null; // eof inside a quoted value
        value = src.slice(i + 1, close);
        i = close + 1;
      } else {
        const vStart = i;
        while (i < src.length && !isSpace(src.charAt(i)) && src.charAt(i) !== ">") i++;
        value = src.slice(vStart, i);
      }
    }

    if (attrName) attrs.push({ name: attrName, value });

    // Belt and braces: no branch above can leave the cursor where it was, but a
    // parser that can loop forever on hostile input is a denial of service, so
    // the invariant is asserted rather than assumed.
    if (i === iterStart) i++;
  }

  return { kind, name, attrs, selfClosing, end: i };
}

/**
 * Index of the `</name` that closes a RAWTEXT element, or -1. Case-insensitive
 * on a fixed-length window so it stays linear (lowercasing the whole document
 * once per candidate would be quadratic).
 */
function findRawTextEnd(src: string, from: number, name: string): number {
  let j = from;
  for (;;) {
    const k = src.indexOf("</", j);
    if (k < 0) return -1;
    const after = k + 2;
    if (src.slice(after, after + name.length).toLowerCase() === name) {
      const next = src.slice(after + name.length, after + name.length + 1);
      if (next === "" || next === ">" || next === "/" || isSpace(next)) return k;
    }
    j = k + 2;
  }
}

/** Serialize an anchor start tag, keeping at most one validated href. */
function serializeAnchor(tok: TagToken): string {
  // HTML5 on a duplicate attribute: the FIRST occurrence wins, later ones are
  // discarded. `<a href="https://x" href="javascript:1">` is therefore the
  // https one for every browser, and we mirror that - then re-serialize a
  // single href, so no downstream parser can pick the other one either way.
  const href = tok.attrs.find((a) => a.name === "href");
  if (href === undefined) return "<a>";
  const url = sanitizeHref(href.value);
  // A refused href leaves an inert `<a>`: the tag is harmless without it and
  // the user's link text is preserved, which beats deleting the sentence.
  return url === null ? "<a>" : `<a href="${escapeAttrValue(url)}">`;
}

/**
 * Sanitize user-written snippet HTML into a safe, valid, stable equivalent.
 *
 * Guarantees on the returned string:
 *  - it contains only the elements of SNIPPET_ALLOWED_TAGS, balanced and
 *    properly nested, at most MAX_NESTING_DEPTH deep;
 *  - the only attribute anywhere is `href` on `a`, and its scheme is one of
 *    ALLOWED_URL_SCHEMES;
 *  - all text is escaped, so it cannot re-parse into markup;
 *  - sanitize(sanitize(x)) === sanitize(x).
 */
export function sanitizeSnippetHtml(input: string): string {
  // The value crosses IPC from the renderer, where the declared type is a
  // promise, not a fact. A boundary that trusts its type annotation is not a
  // boundary.
  if (typeof input !== "string" || input.length === 0) return "";

  const src = input.length > MAX_SNIPPET_HTML_CHARS ? input.slice(0, MAX_SNIPPET_HTML_CHARS) : input;

  const out: string[] = [];
  /** Open allowlisted elements, outermost first. An array, never recursion. */
  const open: string[] = [];
  /** Depth inside a dropped subtree; > 0 means "emit nothing". */
  let dropDepth = 0;
  let dropName = "";
  let i = 0;

  const emitText = (text: string): void => {
    if (dropDepth === 0 && text.length > 0) out.push(encodeTextNode(text));
  };

  /** Close open elements down to and including `name`; no-op if not open. */
  const closeUpTo = (name: string): void => {
    const at = open.lastIndexOf(name);
    if (at < 0) return;
    while (open.length > at) out.push(`</${open.pop() ?? ""}>`);
  };

  const autoClose = (name: string): void => {
    // The subset of HTML5 tree construction that actually shows up in prose. A
    // browser closes an open <p> when a block starts, an open <li> at the next
    // <li>, and an open <a> at the next <a>. Without these three rules we would
    // emit nesting that a browser flattens, i.e. a file that re-parses into a
    // different tree than the one we validated.
    if (name === "p" || name === "ul" || name === "ol") closeUpTo("p");
    else if (name === "li") closeUpTo("li");
    else if (name === "a") closeUpTo("a");
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      emitText(src.slice(i));
      break;
    }
    if (lt > i) emitText(src.slice(i, lt));
    i = lt;

    if (src.startsWith("<!--", i)) {
      // Comments are dropped whole, contents included. Conditional comments
      // (`<!--[if IE]> ... <![endif]-->`) are just comments to this loop, so
      // whatever an old engine would have revealed inside one is dropped with
      // it. An unterminated comment eats the rest of the input, which is the
      // strict direction: we never expose text a reader might not.
      const body = i + 4;
      if (src.startsWith(">", body)) {
        i = body + 1;
        continue;
      }
      if (src.startsWith("->", body)) {
        i = body + 2;
        continue;
      }
      // ONE scan for whichever terminator comes first, and that is the whole
      // difference between linear and quadratic. Searching the two forms
      // separately is the trap: a document that uses one never contains the
      // other, so the FAILING indexOf walks the entire remaining input, for
      // every comment. Measured on 1 MiB of ordinary `<!---->`: 93 582 ms with
      // two indexOf calls, 6 ms with this exec. (Bounding only the `--!>`
      // search moves the cost instead of removing it - a document of `--!>`
      // comments then pays the failing `-->` scan, measured at 7 706 ms.) That
      // cost is a SYNCHRONOUS freeze of the main process, the one holding the
      // keyboard hook, so it takes dictation, tray and IPC down with it.
      //
      // exec() stops at the first match, which is inside the region the cursor
      // is about to consume, so the scans of successive comments never overlap.
      // The only full scan is the one that finds nothing, and it ends the walk:
      // an unterminated comment eats to EOF.
      COMMENT_END_RE.lastIndex = body;
      const end = COMMENT_END_RE.exec(src);
      i = end === null ? src.length : end.index + end[0].length;
      continue;
    }

    if (src.startsWith("<!", i)) {
      // DOCTYPE, CDATA, and every other markup declaration: a bogus comment
      // ending at the first ">", exactly as a browser treats it. Dropped.
      const end = src.indexOf(">", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    if (src.startsWith("</", i)) {
      if (!isAsciiAlpha(src.charAt(i + 2))) {
        // "</>" or "</ x": a bogus comment, not an end tag.
        const end = src.indexOf(">", i + 2);
        i = end < 0 ? src.length : end + 1;
        continue;
      }
      const tok = readTag(src, i, "end");
      if (tok === null) break; // eof-in-tag: nothing left to read
      i = tok.end;
      if (dropDepth > 0) {
        if (tok.name === dropName) {
          dropDepth--;
          if (dropDepth === 0) dropName = "";
        }
        continue;
      }
      // A stray end tag, or an end tag for something we removed, is discarded:
      // it has no opener in OUR output, so emitting it would unbalance the file.
      if (SNIPPET_ALLOWED_TAGS.has(tok.name) && !VOID_TAGS.has(tok.name)) closeUpTo(tok.name);
      continue;
    }

    if (isAsciiAlpha(src.charAt(i + 1))) {
      const tok = readTag(src, i, "start");
      if (tok === null) break; // eof-in-tag: the tag and the rest are dropped
      i = tok.end;

      if (dropDepth > 0) {
        // Only the tag we are waiting for changes the depth; everything else
        // inside the dropped subtree is discarded without interpretation. Same
        // rule as below on the solidus: `<object/>` nested in an `<object>` is
        // a real open element for a browser, so it has to raise the depth or
        // the first `</object>` would end the drop one level too early and
        // spill the rest of the subtree back into the output.
        if (tok.name === dropName && !isEmptyDroppedElement(tok)) dropDepth++;
        continue;
      }

      if (SNIPPET_DROPPED_SUBTREE_TAGS.has(tok.name)) {
        if (isEmptyDroppedElement(tok)) continue; // genuinely no content to skip
        if (RAW_TEXT_TAGS.has(tok.name)) {
          const end = findRawTextEnd(src, tok.end, tok.name);
          // Unterminated: the payload runs to EOF, so we drop to EOF too.
          if (end < 0) break;
          // Leave the cursor ON the "</name": the end-tag branch above consumes
          // it and discards it, which keeps the quoting rules in one place.
          i = end;
          continue;
        }
        dropDepth = 1;
        dropName = tok.name;
        continue;
      }

      if (SNIPPET_ALLOWED_TAGS.has(tok.name)) {
        if (VOID_TAGS.has(tok.name)) {
          // Self-closing form so the file is also well-formed for a consumer
          // that parses it as XML rather than as HTML.
          out.push("<br />");
          continue;
        }
        autoClose(tok.name);
        if (open.length < MAX_NESTING_DEPTH) {
          open.push(tok.name);
          out.push(tok.name === "a" ? serializeAnchor(tok) : `<${tok.name}>`);
        }
        // Over the cap the tag is dropped and its content keeps flowing, the
        // same treatment as a non-allowlisted element. Note the solidus in
        // `<span/>` is ignored for non-void elements, as in HTML.
        continue;
      }

      // Not allowlisted and not a dropped subtree: the TAG goes, the content
      // stays. `<div>bonjour</div>` is `bonjour`; `<img src=x onerror=...>` is
      // nothing at all, because an image has no text content to keep.
      continue;
    }

    // A "<" that opens nothing - "a < b", "<", "<3" - is text, exactly as the
    // tokenizer treats it, and comes out as "&lt;".
    emitText("<");
    i += 1;
  }

  // Whatever the input left open, we close: the stored file is balanced even
  // when the user's markup was not, so nobody has to guess where `<b>gras`
  // ended.
  while (open.length > 0) out.push(`</${open.pop() ?? ""}>`);

  return out.join("");
}
