// U3f: the decision of whether page content may hand a URL to the OS
// (shell.openExternal), extracted as PURE logic so it is unit-testable
// without an Electron process - same reasoning as route.ts/combo.ts next to
// it. mainWindow.ts is the one caller: it applies the decision by actually
// invoking shell.openExternal and logging a refusal.
//
// TWO independent refusals, for two independent reasons:
//  - scheme: only http/https/mailto ever reach the OS, mirroring
//    htmlSanitize.ts's ALLOWED_URL_SCHEMES - a link this app would not have
//    STORED in a snippet (see that module) is not one it will OPEN from a
//    stray navigation either. A bare file://, chrome://, or javascript:
//    target has no business leaving the app.
//  - loopback host: the sanitizer accepts http(s) to ANY host, including
//    Flow's own local API (127.0.0.1). A snippet's <a href> pointing there
//    would be a CSRF shaped like a hyperlink - one click fires a
//    same-origin-looking request at an API that otherwise expects a
//    same-machine caller. The sanitizer has no notion of "this host is us";
//    that knowledge lives here instead, at the one place a URL from page
//    content is actually acted on.

export interface NavAllowed {
  allow: true;
  url: string;
}
export interface NavRefused {
  allow: false;
  reason: string;
}
export type NavDecision = NavAllowed | NavRefused;

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"]);

// ---------------------------------------------------------------------------
// U3g (review, major): "this machine" is a FAMILY, not a list of spellings
// ---------------------------------------------------------------------------
// The first version compared against exactly four strings, and two trivially
// reachable hostnames walked straight past it (both verified under Node's
// WHATWG parser, which is the same one Chromium uses):
//   new URL("http://localhost.:8176/x").hostname          -> "localhost."
//   new URL("http://[::ffff:127.0.0.1]:8176/x").hostname  -> "[::ffff:7f00:1]"
// Both name the machine Flow's own local API listens on, so both were the
// CSRF-shaped link the check exists to refuse.
//
// The fix is in two halves, and the split matters. NORMALIZE first (case, the
// DNS root's trailing dot, IPv6 brackets), then decide by ADDRESS FAMILY rather
// than by string equality: the whole 127.0.0.0/8 block, ::1, every IPv4-mapped
// or IPv4-compatible embedding of a 127.x address, the unspecified addresses,
// and localhost with its RFC 6761 subdomains. Enumerating spellings is what
// failed; enumerating the family cannot be bypassed by a new way of writing an
// address the parser already understands.
//
// One thing this file deliberately does NOT do: parse numeric shorthands like
// "http://2130706433/" or "http://127.1/". The WHATWG parser canonicalizes
// those to "127.0.0.1" before URL.hostname is ever read (both verified), so
// they arrive here already in dotted form. This function's contract is "a
// hostname as a URL parser produced it".

/** Normalize a hostname to the form the checks below compare against: lower
 * case, no trailing DNS root dot ("localhost." IS "localhost"), no IPv6
 * brackets. */
function normalizeHost(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  // The trailing dot is the explicit root label. The WHATWG parser keeps it, so
  // this is the only place it can be removed. A loop, not a single slice:
  // "localhost.." is still the same host.
  while (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1);
  if (h.length > 1 && h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The whole 127.0.0.0/8 block, plus 0.0.0.0. Not just 127.0.0.1: every
 * address in that /8 is the loopback interface, and Flow's API answers on it
 * (127.0.0.2 reaches the same listener on Windows and Linux). 0.0.0.0 is the
 * unspecified address, which connects to the local host on every platform that
 * accepts it - the "0.0.0.0 day" bypass of exactly this kind of check. */
function isLoopbackIpv4(h: string): boolean {
  const m = IPV4_RE.exec(h);
  if (m === null) return false;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return false;
  return o[0] === 127 || (o[0] === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0);
}

/**
 * Expand an IPv6 literal into its 16 bytes, or null when it is not one.
 *
 * Written out rather than pattern-matched because the loopback family has too
 * many valid renderings to enumerate: "::1", "0:0:0:0:0:0:0:1",
 * "::ffff:127.0.0.1" (what a human types) and "::ffff:7f00:1" (what the URL
 * parser returns for that same address) all have to reach the same verdict.
 * Comparing bytes is the only way to say that once.
 */
function ipv6Bytes(h: string): number[] | null {
  if (!h.includes(":")) return null;
  let src = h;
  // A trailing dotted quad ("::ffff:127.0.0.1") folds into two hex groups, so
  // the rest of the parse never has to know about the mixed notation.
  const lastColon = src.lastIndexOf(":");
  const tail = src.slice(lastColon + 1);
  if (tail.includes(".")) {
    const quad = IPV4_RE.exec(tail);
    if (quad === null) return null;
    const o = [Number(quad[1]), Number(quad[2]), Number(quad[3]), Number(quad[4])];
    if (o.some((n) => n > 255)) return null;
    src = src.slice(0, lastColon + 1) + (o[0] * 256 + o[1]).toString(16) + ":" + (o[2] * 256 + o[3]).toString(16);
  }
  const halves = src.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once
  const groupsOf = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (head === null || rest === null) return null;
  const missing = 8 - head.length - rest.length;
  // "::" stands for AT LEAST one zero group; without it the address must be
  // complete. Anything else is malformed, and a malformed host is not loopback.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  return bytes;
}

/** The IPv4 embeddings whose low 32 bits are a real IPv4 address: ::a.b.c.d
 * (IPv4-compatible), ::ffff:a.b.c.d (IPv4-mapped) and ::ffff:0:a.b.c.d
 * (IPv4-translated). Bytes 8..11 are what distinguishes them. */
const V4_EMBEDDINGS: readonly number[][] = [
  [0, 0, 0, 0],
  [0, 0, 0xff, 0xff],
  [0xff, 0xff, 0, 0],
];

function isLoopbackIpv6(h: string): boolean {
  const b = ipv6Bytes(h);
  if (b === null) return false;
  const highZero = b.slice(0, 8).every((n) => n === 0);
  if (!highZero) return false;
  // ::1 (loopback) and :: (unspecified), same reasoning as 0.0.0.0 above.
  if (b.slice(8, 15).every((n) => n === 0) && (b[15] === 1 || b[15] === 0)) return true;
  const embedding = b.slice(8, 12);
  if (!V4_EMBEDDINGS.some((e) => e.every((n, i) => n === embedding[i]))) return false;
  return b[12] === 127;
}

/**
 * "This machine, not a remote host" - the whole family, normalized first.
 *
 * Covers: 127.0.0.0/8 and 0.0.0.0; ::1 and :: (bracketed or not); every
 * IPv4-mapped / -compatible / -translated form of a 127.x address; localhost,
 * its case variants, its trailing-dot form, and its subdomains (RFC 6761
 * reserves *.localhost for the loopback interface, and Chromium resolves them
 * there).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return isLoopbackIpv4(h) || isLoopbackIpv6(h);
}

/**
 * Decide whether `rawUrl` may be handed to shell.openExternal. Never throws:
 * an unparseable URL is simply refused, same outcome as any other
 * disallowed shape - a caller does not need a try/catch of its own.
 */
export function decideExternalOpen(rawUrl: string): NavDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allow: false, reason: "malformed URL" };
  }
  const scheme = url.protocol.slice(0, -1); // URL.protocol keeps the trailing ":"
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { allow: false, reason: `scheme not allowed: ${scheme}` };
  }
  // mailto has no meaningful hostname (url.hostname is "" for it) - the
  // loopback check only applies to the two schemes that actually name a host.
  if (scheme !== "mailto" && isLoopbackHost(url.hostname)) {
    return { allow: false, reason: `loopback host refused: ${url.hostname}` };
  }
  return { allow: true, url: rawUrl };
}
