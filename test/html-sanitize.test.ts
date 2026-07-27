import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NESTING_DEPTH,
  MAX_SNIPPET_HTML_CHARS,
  escapeHtmlText,
  sanitizeHref,
  sanitizeSnippetHtml,
} from "../src/shared/htmlSanitize";

// Every markup form the sanitizer is allowed to WRITE. Anything else in the
// output is, by definition, a hole: the module's whole security argument is
// that it re-serializes instead of filtering, so the output alphabet is finite
// and this regex is it.
const EMITTED_TAG_RE =
  /<\/?(?:b|strong|i|em|u|a|p|ul|ol|li|span)>|<br \/>|<a href="[^"<>]*">/g;

/**
 * The invariant every single output has to satisfy, whatever the input:
 * once the tags we are allowed to emit are removed, nothing that can start
 * markup is left, and the tags that were there are balanced and well nested.
 */
function assertStructurallySafe(html: string, label: string): void {
  const text = html.replace(EMITTED_TAG_RE, "");
  assert.equal(text.includes("<"), false, `stray "<" in output for ${label}: ${html.slice(0, 200)}`);
  assert.equal(text.includes(">"), false, `stray ">" in output for ${label}: ${html.slice(0, 200)}`);

  const stack: string[] = [];
  for (const m of html.matchAll(EMITTED_TAG_RE)) {
    const tag = m[0];
    if (tag === "<br />") continue;
    if (tag.startsWith("</")) {
      assert.equal(stack.pop(), tag.slice(2, -1), `unbalanced close ${tag} in ${label}`);
    } else {
      stack.push(tag.startsWith("<a") ? "a" : tag.slice(1, -1));
    }
  }
  assert.deepEqual(stack, [], `unclosed elements in ${label}: ${stack.join(",")}`);
}

// Shared corpus: every hostile or malformed input the suite knows about. Used
// by the structural invariant and by the idempotence test, so any case added
// below is automatically checked for both.
const CORPUS: string[] = [
  "",
  "a < b & c",
  "Roch's \"snippet\" : 5 < 6 & 7 > 3",
  "<p>Bonjour <b>Roch</b>, <em>merci</em>.<br>A demain</p>",
  "<div>bonjour</div>",
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">clic</a>',
  '<a href="JaVaScRiPt:alert(1)">clic</a>',
  '<a href="java&#115;cript:alert(1)">clic</a>',
  '<a href="java\tscript:alert(1)">clic</a>',
  '<a href="\u0001javascript:alert(1)">clic</a>',
  '<a href="   javascript:alert(1)">clic</a>',
  '<a href="&#106;avascript:alert(1)">clic</a>',
  '<a href="javascript&colon;alert(1)">clic</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="https://x" href="javascript:1">dup</a>',
  '<a href="https://ex.com/?a=1&b=2">amp</a>',
  '<a href="/relatif">rel</a>',
  "<script>alert(1)</script>",
  "<style>p{background:url(javascript:1)}</style>",
  '<iframe src="evil"></iframe>',
  "<object data=x>fallback</object>",
  "<embed src=x>apres",
  "<template><b>x</b></template>",
  "<noscript><b>x</b></noscript>",
  "<svg onload=alert(1)><circle r=1 /></svg>",
  "<math><mi>x</mi></math>",
  "<svg><svg></svg></svg>apres",
  "<script>if (a<b) { alert(1) }</script>reste",
  "<script>alert(1)",
  "<script/>alert(1)</script>apres",
  "<style/>p{}</style>apres",
  "<iframe/>x</iframe>apres",
  "<svg/>apres",
  "<math/>apres",
  "<object><object/>x</object>apres",
  "a<!-- 1 --!> 2 --!> 3 -->b",
  "<!---->".repeat(20),
  "<!-- c -->texte ".repeat(20),
  '<p style="x" class="y" id="z" onclick="alert(1)">t</p>',
  "<b>gras",
  "<p><b></p></b>",
  "<a href=",
  "<",
  "</b>",
  "<b><i>x</b></i>",
  "<p>a<p>b",
  "<ul><li>a<li>b</ul>",
  "a<!-- commentaire -->b",
  "<!--[if IE]><script>alert(1)</script><![endif]-->",
  "<!-- pas de fin",
  "<!-->apres",
  "<!DOCTYPE html>x",
  "<![CDATA[<img src=x onerror=1>]]>y",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "&#60;script&#62;",
  "&eacute;t&eacute; &hellip; &amp;eacute;",
  "a\u0000b\u0007c",
  "<b>".repeat(200) + "x" + "</b>".repeat(200),
  "<b<b<b<b<b",
  "<<<<>>>>",
];

test("plain text comes out escaped, readable and inert", () => {
  assert.equal(sanitizeSnippetHtml("a < b & c"), "a &lt; b &amp; c");
  assert.equal(sanitizeSnippetHtml("5 > 3"), "5 &gt; 3");
  // Quotes stay readable: escaping them would be pointless in a text node and
  // would make the stored file unpleasant to read.
  assert.equal(sanitizeSnippetHtml("Roch's \"note\""), "Roch's \"note\"");
  assert.equal(sanitizeSnippetHtml(""), "");
  assert.equal(escapeHtmlText("a < b & c"), "a &lt; b &amp; c");
});

test("the allowlist survives intact", () => {
  assert.equal(
    sanitizeSnippetHtml("<p>Bonjour <b>Roch</b>, <em>merci</em>.<br>A demain</p>"),
    "<p>Bonjour <b>Roch</b>, <em>merci</em>.<br />A demain</p>",
  );
  for (const tag of ["b", "strong", "i", "em", "u", "p", "ul", "ol", "li", "span"]) {
    assert.equal(sanitizeSnippetHtml(`<${tag}>x</${tag}>`), `<${tag}>x</${tag}>`, tag);
  }
  assert.equal(sanitizeSnippetHtml("<br>"), "<br />");
  assert.equal(sanitizeSnippetHtml("<br/>"), "<br />");
  assert.equal(
    sanitizeSnippetHtml('<a href="https://agrlabs.ca">site</a>'),
    '<a href="https://agrlabs.ca">site</a>',
  );
  assert.equal(
    sanitizeSnippetHtml("<ul><li>un</li><li>deux</li></ul>"),
    "<ul><li>un</li><li>deux</li></ul>",
  );
});

test("an element outside the allowlist loses its tag but keeps its text", () => {
  assert.equal(sanitizeSnippetHtml("<div>bonjour</div>"), "bonjour");
  assert.equal(sanitizeSnippetHtml("<h1>Titre</h1>"), "Titre");
  assert.equal(sanitizeSnippetHtml("<table><tr><td>cellule</td></tr></table>"), "cellule");
  assert.equal(sanitizeSnippetHtml('<font color="red">rouge</font>'), "rouge");
  assert.equal(sanitizeSnippetHtml("<form><input value=x></form>"), "");
  assert.equal(sanitizeSnippetHtml("<blink>a</blink><marquee>b</marquee>"), "ab");
});

test("<img src=x onerror=alert(1)> leaves nothing at all", () => {
  assert.equal(sanitizeSnippetHtml("<img src=x onerror=alert(1)>"), "");
  assert.equal(sanitizeSnippetHtml('<img src="x" onerror="alert(1)" />'), "");
  // The "/" glued to the tag name is the classic filter bypass: it must not
  // turn the token into something we fail to recognize as <img>.
  assert.equal(sanitizeSnippetHtml("<img/src=x onerror=alert(1)>"), "");
  assert.equal(sanitizeSnippetHtml("avant<img src=x onerror=alert(1)>apres"), "avantapres");
});

test("script, style, iframe, object, embed, template, noscript, svg and math lose their content", () => {
  assert.equal(sanitizeSnippetHtml("<script>alert(1)</script>"), "");
  assert.equal(sanitizeSnippetHtml("a<script>alert(1)</script>b"), "ab");
  assert.equal(sanitizeSnippetHtml("<SCRIPT>alert(1)</SCRIPT>"), "");
  assert.equal(sanitizeSnippetHtml("<style>p{background:url(javascript:1)}</style>"), "");
  assert.equal(sanitizeSnippetHtml('<iframe src="evil"></iframe>'), "");
  assert.equal(sanitizeSnippetHtml("<object data=x>fallback</object>"), "");
  assert.equal(sanitizeSnippetHtml("<template><b>x</b></template>"), "");
  assert.equal(sanitizeSnippetHtml("<noscript><b>x</b></noscript>"), "");
  assert.equal(sanitizeSnippetHtml("<svg onload=alert(1)><circle r=1 /></svg>"), "");
  assert.equal(sanitizeSnippetHtml("<math><mi>x</mi></math>"), "");
  // embed is VOID: only the tag goes, the following sibling text stays.
  assert.equal(sanitizeSnippetHtml("<embed src=x>apres"), "apres");
  // Nesting a dropped element in itself must not end the drop too early.
  assert.equal(sanitizeSnippetHtml("<svg><svg></svg></svg>apres"), "apres");
  // RAWTEXT: the "<b)" inside a script is not a tag for a browser and must not
  // be one for us either, or the drop would end in the wrong place.
  assert.equal(sanitizeSnippetHtml("<script>if (a<b) { alert(1) }</script>reste"), "reste");
  // Unterminated: the payload runs to EOF, so the drop does too.
  assert.equal(sanitizeSnippetHtml("<script>alert(1)"), "");
  assert.equal(sanitizeSnippetHtml("<svg>charge utile"), "");
});

test("a trailing solidus does not neutralize the subtree drop", () => {
  // `<script/>` is NOT an empty script. For an ordinary HTML element the HTML5
  // tokenizer IGNORES the trailing solidus, so this is an open `script` whose
  // content is `alert(1)` - and treating it as empty let that content out as
  // visible text, which is the whole point of dropping the subtree. One
  // character, and the strongest rule in the file was off.
  assert.equal(sanitizeSnippetHtml("<script/>alert(1)</script>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<script />alert(1)</script>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<SCRIPT/>alert(1)</SCRIPT>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<script/>alert(1)"), "", "unterminated: the payload runs to EOF, so does the drop");
  assert.equal(sanitizeSnippetHtml("<style/>p{background:url(javascript:1)}</style>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<iframe/>x</iframe>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<noscript/>x</noscript>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<object/>x</object>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<template/>x</template>apres"), "apres");
  // Same rule one level down: `<object/>` inside an `<object>` is a real open
  // element, so it raises the drop depth and the first `</object>` no longer
  // ends the drop. "apres" is inside the outer object for a browser too.
  assert.equal(sanitizeSnippetHtml("<object><object/>x</object>apres"), "");

  // FOREIGN content is the exception, and the only one: HTML5 acknowledges the
  // self-closing flag on `<svg>` and `<math>`, so `<svg/>` really is empty and
  // what follows really is ordinary HTML. Dropping the rest of the document
  // here would destroy the user's text for no security gain.
  assert.equal(sanitizeSnippetHtml("<svg/>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<math/>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<svg/><b>gras</b>"), "<b>gras</b>");
  assert.equal(sanitizeSnippetHtml("<svg><svg/>x</svg>apres"), "apres");
  // ...and a self-closed foreign tag still cannot smuggle a script out.
  assert.equal(sanitizeSnippetHtml("<svg/><script>alert(1)</script>apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<svg><script/>alert(1)</script></svg>apres"), "apres");
  // embed stays void: only the tag goes, the sibling text stays.
  assert.equal(sanitizeSnippetHtml("<embed/>apres"), "apres");
});

test("javascript: hrefs are refused, including every naive-filter bypass", () => {
  const bypasses = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java&#115;cript:alert(1)",
    "java&#x73;cript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#106avascript:alert(1)", // numeric reference without its semicolon
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "\u0001javascript:alert(1)",
    "   javascript:alert(1)",
    "\t javascript:alert(1)",
    "javascript&colon;alert(1)",
    "javascript&#58;alert(1)",
    "vbscript:msgbox(1)",
    "jav ascript:alert(1)", // a space is NOT stripped: this stays a relative URL
    "&#0000106;avascript:alert(1)", // padded numeric reference
    "&#X6A;avascript:alert(1)", // uppercase hex marker
    "&#00000000106;avascript:alert(1)", // longer than we decode: refused, not accepted
    "jav\u0000ascript:alert(1)",
  ];
  for (const url of bypasses) {
    assert.equal(sanitizeHref(url), null, `sanitizeHref accepted ${JSON.stringify(url)}`);
    const html = sanitizeSnippetHtml(`<a href="${url}">clic</a>`);
    assert.equal(html, "<a>clic</a>", `sanitize kept ${JSON.stringify(url)}`);
    assert.equal(/javascript|vbscript/i.test(html), false, url);
  }
});

test("data: hrefs are refused, base64 payload included", () => {
  const payload = "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";
  assert.equal(sanitizeHref(payload), null);
  assert.equal(sanitizeSnippetHtml(`<a href="${payload}">x</a>`), "<a>x</a>");
  // Refused on purpose even when it is only an image: an allowlist of three
  // schemes is the point, and a data: URL in a stored file is a payload
  // whatever its declared type.
  assert.equal(sanitizeHref("data:image/png;base64,iVBORw0KGgo="), null);
});

test("every attribute is dropped except href on a", () => {
  assert.equal(sanitizeSnippetHtml('<p style="position:fixed;top:0" class="x" id="y">t</p>'), "<p>t</p>");
  assert.equal(sanitizeSnippetHtml('<span style="background:url(javascript:1)">t</span>'), "<span>t</span>");
  assert.equal(sanitizeSnippetHtml('<b title="x" data-foo="y" aria-label="z">t</b>'), "<b>t</b>");
  assert.equal(
    sanitizeSnippetHtml('<a href="https://x.com" target="_blank" rel="noopener" download>t</a>'),
    '<a href="https://x.com">t</a>',
  );
  // href is only meaningful on <a>: everywhere else it is just an attribute.
  assert.equal(sanitizeSnippetHtml('<p href="https://x.com">t</p>'), "<p>t</p>");
  // Unquoted and single-quoted values are parsed the same way, so neither is a
  // way in.
  assert.equal(sanitizeSnippetHtml("<a href=javascript:alert(1)>t</a>"), "<a>t</a>");
  assert.equal(sanitizeSnippetHtml("<a href='https://x.com'>t</a>"), '<a href="https://x.com">t</a>');
  assert.equal(sanitizeSnippetHtml("<a href = 'https://x.com' >t</a>"), '<a href="https://x.com">t</a>');
  // A solidus glued to the previous value does not smuggle the next attribute
  // past the parser.
  assert.equal(
    sanitizeSnippetHtml('<a href="https://x.com"/onclick=alert(1)>t</a>'),
    '<a href="https://x.com">t</a>',
  );
});

test("on* handlers are removed in every spelling", () => {
  for (const attr of [
    'onclick="alert(1)"',
    "onmouseover=alert(1)",
    "ONLOAD=alert(1)",
    "OnError='alert(1)'",
    "onfocus\t=\talert(1)",
    "onpointerdown=alert&#40;1&#41;",
  ]) {
    assert.equal(sanitizeSnippetHtml(`<b ${attr}>t</b>`), "<b>t</b>", attr);
    assert.equal(
      sanitizeSnippetHtml(`<a href="https://x.com" ${attr}>t</a>`),
      '<a href="https://x.com">t</a>',
      attr,
    );
  }
});

test("a relative or schemeless href is refused: the app has no base URL", () => {
  for (const url of ["/page", "page.html", "#ancre", "//evil.com/x", "", "   ", "?q=1", "/a:b", "./x", "../x"]) {
    assert.equal(sanitizeHref(url), null, JSON.stringify(url));
  }
  assert.equal(sanitizeSnippetHtml('<a href="/page">lien</a>'), "<a>lien</a>");
  assert.equal(sanitizeSnippetHtml("<a>sans href</a>"), "<a>sans href</a>");
});

test("http, https and mailto pass, and the kept value is the one we validated", () => {
  assert.equal(sanitizeHref("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(sanitizeHref("http://example.com"), "http://example.com");
  assert.equal(sanitizeHref("mailto:roch@agrlabs.ca"), "mailto:roch@agrlabs.ca");
  assert.equal(sanitizeHref("HTTPS://Example.com/Path"), "HTTPS://Example.com/Path");
  // A URL with control characters is stored CLEANED, so the bytes we checked
  // are the bytes a reader will follow.
  assert.equal(sanitizeHref("  https://ex.com/a\tb  "), "https://ex.com/ab");
  // "&" in a query has to be re-escaped, or the stored HTML is invalid.
  assert.equal(
    sanitizeSnippetHtml('<a href="https://ex.com/?a=1&b=2">x</a>'),
    '<a href="https://ex.com/?a=1&amp;b=2">x</a>',
  );
  assert.equal(
    sanitizeSnippetHtml('<a href="https://ex.com/?a=1&amp;b=2">x</a>'),
    '<a href="https://ex.com/?a=1&amp;b=2">x</a>',
  );
  // A quote inside the value cannot break out of the attribute.
  assert.equal(
    sanitizeSnippetHtml("<a href='https://ex.com/\"><script>alert(1)</script>'>x</a>"),
    '<a href="https://ex.com/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x</a>',
  );
});

test("a duplicated href keeps the first, exactly as a browser does", () => {
  const html = sanitizeSnippetHtml('<a href="https://x.com" href="javascript:1">dup</a>');
  assert.equal(html, '<a href="https://x.com">dup</a>');
  assert.equal(html.includes("javascript"), false);
  // Reversed: the first is the hostile one, so the anchor loses its href
  // entirely rather than silently falling back to the second.
  assert.equal(
    sanitizeSnippetHtml('<a href="javascript:1" href="https://x.com">dup</a>'),
    "<a>dup</a>",
  );
});

test("malformed markup comes out valid and balanced", () => {
  assert.equal(sanitizeSnippetHtml("<b>gras"), "<b>gras</b>");
  assert.equal(sanitizeSnippetHtml("<p><b></p></b>"), "<p><b></b></p>");
  assert.equal(sanitizeSnippetHtml("<b><i>x</b></i>"), "<b><i>x</i></b>");
  assert.equal(sanitizeSnippetHtml("</b>"), "");
  assert.equal(sanitizeSnippetHtml("</b>texte"), "texte");
  // EOF inside a tag: the token is dropped, which is what a browser does too.
  assert.equal(sanitizeSnippetHtml("<a href="), "");
  assert.equal(sanitizeSnippetHtml('<a href="https://x.com'), "");
  assert.equal(sanitizeSnippetHtml("<b"), "");
  // A "<" that opens nothing is text.
  assert.equal(sanitizeSnippetHtml("<"), "&lt;");
  assert.equal(sanitizeSnippetHtml("a < b"), "a &lt; b");
  assert.equal(sanitizeSnippetHtml("<3 <>"), "&lt;3 &lt;&gt;");
  // Implicit closes, so the output nests the way a browser would read it back.
  assert.equal(sanitizeSnippetHtml("<p>a<p>b"), "<p>a</p><p>b</p>");
  assert.equal(sanitizeSnippetHtml("<ul><li>a<li>b</ul>"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(
    sanitizeSnippetHtml('<a href="https://x.com">1<a href="https://y.com">2</a>'),
    '<a href="https://x.com">1</a><a href="https://y.com">2</a>',
  );
});

test("comments are dropped whole, conditional comments included", () => {
  assert.equal(sanitizeSnippetHtml("a<!-- commentaire -->b"), "ab");
  assert.equal(sanitizeSnippetHtml("<!--[if IE]><script>alert(1)</script><![endif]-->"), "");
  assert.equal(sanitizeSnippetHtml("a<!--[if lt IE 9]>b<![endif]-->c"), "ac");
  assert.equal(sanitizeSnippetHtml("<!-- jamais ferme <b>x"), "");
  assert.equal(sanitizeSnippetHtml("<!-->apres"), "apres");
  assert.equal(sanitizeSnippetHtml("<!--->apres"), "apres");
  assert.equal(sanitizeSnippetHtml("a<!-- x --!>b"), "ab");
  assert.equal(sanitizeSnippetHtml("<!DOCTYPE html>x"), "x");
  // A CDATA section is a bogus comment in HTML: it ends at the first ">", and
  // whatever follows is text, never markup.
  assert.equal(sanitizeSnippetHtml("<![CDATA[<img src=x onerror=1>]]>y"), "]]&gt;y");
});

test("entities decode then re-escape instead of stacking up", () => {
  // The critical one: an entity-encoded tag must stay text.
  assert.equal(sanitizeSnippetHtml("&lt;script&gt;alert(1)&lt;/script&gt;"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(sanitizeSnippetHtml("&#60;script&#62;"), "&lt;script&gt;");
  assert.equal(sanitizeSnippetHtml("&#x3C;script&#x3E;"), "&lt;script&gt;");
  assert.equal(sanitizeSnippetHtml("&amp;"), "&amp;");
  assert.equal(sanitizeSnippetHtml("&amp;lt;"), "&amp;lt;");
  // An entity we do not know keeps its shape: accents and typography survive.
  assert.equal(sanitizeSnippetHtml("&eacute;t&eacute; &hellip;"), "&eacute;t&eacute; &hellip;");
  assert.equal(sanitizeSnippetHtml("&amp;eacute;"), "&amp;eacute;");
  // Control characters never reach the stored file, written raw or encoded.
  assert.equal(sanitizeSnippetHtml("a\u0000b\u0007c"), "abc");
  assert.equal(sanitizeSnippetHtml("a&#1;b"), "ab");
  assert.equal(sanitizeSnippetHtml("ligne1\nligne2\ttab"), "ligne1\nligne2\ttab");
});

test("nesting is capped, and the cap is a stable fixed point", () => {
  const deep = "<b>".repeat(200) + "x" + "</b>".repeat(200);
  const out = sanitizeSnippetHtml(deep);
  assert.equal(out, "<b>".repeat(MAX_NESTING_DEPTH) + "x" + "</b>".repeat(MAX_NESTING_DEPTH));
  assert.equal(sanitizeSnippetHtml(out), out);
  assertStructurallySafe(out, "deep nesting");
});

test("a 1 MB input is handled linearly, and the cap is enforced above it", () => {
  const unit = '<p>Bonjour <b>Roch</b> &amp; <a href="https://ex.com/?a=1&b=2">lien</a></p>';
  const big = unit.repeat(Math.ceil(1_000_000 / unit.length));
  assert.ok(big.length >= 1_000_000);
  assert.ok(big.length <= MAX_SNIPPET_HTML_CHARS);

  const started = Date.now();
  const out = sanitizeSnippetHtml(big);
  const elapsed = Date.now() - started;
  // Generous, but a quadratic or backtracking regression blows straight
  // through it instead of hanging the suite forever.
  assert.ok(elapsed < 5000, `1 MB took ${elapsed}ms`);
  assert.equal(out.includes("<script"), false);
  assertStructurallySafe(out, "1 MB input");

  // Pathological shapes that a naive tokenizer turns quadratic or explodes on.
  for (const nasty of [
    "<".repeat(200_000),
    "&".repeat(200_000),
    "<b".repeat(100_000),
    "<div>".repeat(100_000),
    "<!--".repeat(50_000),
    '<a href="'.repeat(50_000),
    "<script>".repeat(50_000),
    "&#".repeat(200_000),
  ]) {
    const t0 = Date.now();
    assertStructurallySafe(sanitizeSnippetHtml(nasty), `pathological ${nasty.slice(0, 8)}`);
    assert.ok(Date.now() - t0 < 5000, `pathological input took too long: ${nasty.slice(0, 8)}`);
  }

  // Over the cap the input is truncated, and a truncated tail is just EOF: the
  // output is still balanced and still safe.
  const over = "<p>ok</p>".repeat(Math.ceil(MAX_SNIPPET_HTML_CHARS / 9) + 100);
  assert.ok(over.length > MAX_SNIPPET_HTML_CHARS);
  assertStructurallySafe(sanitizeSnippetHtml(over), "over the cap");
});

test("a document full of TERMINATED comments stays linear", () => {
  // This case exists because the pathological corpus above is a FALSE FRIEND on
  // comments: `"<!--".repeat(50_000)` is UNTERMINATED, so both terminator
  // searches fail once, the comment eats to EOF, and the whole input is done in
  // 1 ms no matter how the search is written. A document of TERMINATED comments
  // is the shape that actually bills the search once per comment, and it is the
  // ordinary shape - every editor and every CMS emits terminated comments.
  //
  // Measured with the two unbounded indexOf calls this replaced: 6 878 ms at
  // 40 000 comments, 93 582 ms at 1 MiB, growing 4x per doubling (textbook
  // quadratic). With the single `--!?>` scan: single-digit ms. The 1 500 ms
  // bound below therefore sits ~10x under the broken timings and ~100x over the
  // fixed ones, so it fails on the regression without being flaky on a slow
  // machine.
  //
  // It matters more than a slow save: sanitizeSnippetHtml runs SYNCHRONOUSLY in
  // the main process, the one holding the keyboard hook, so this is dictation,
  // tray and IPC frozen for the duration.
  for (const [label, input] of [
    ["empty terminated comments", "<!---->".repeat(60_000)],
    ["comments interleaved with prose", "<!-- c -->texte ".repeat(60_000)],
  ] as const) {
    const t0 = Date.now();
    const out = sanitizeSnippetHtml(input);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1500, `${label} took ${elapsed}ms (quadratic comment scan is back)`);
    assertStructurallySafe(out, label);
  }
  // The rarer `--!>` form gets the same bound, and it is not decoration: a
  // document that uses ONE terminator never contains the other, so whichever
  // search is left unbounded is the one that pays. Bounding only the `--!>`
  // side left this exact shape at 7 665 ms - the failing `-->` scan had simply
  // taken over. One scan for both forms is what actually closes it (7 ms).
  const t1 = Date.now();
  assert.equal(sanitizeSnippetHtml("<!-- c --!>t ".repeat(40_000)).length, 40_000 * 2);
  assert.ok(Date.now() - t1 < 1500, "the --!> form went quadratic");
  assert.equal(sanitizeSnippetHtml("a<!-- x --!> y --> z -->b"), "a y --&gt; z --&gt;b");
  assert.equal(sanitizeSnippetHtml("a<!-- x --> y --!> z -->b"), "a y --!&gt; z --&gt;b");
  // Two `--!>` before the `-->`: the FIRST one closes the comment, so the rest
  // is text. A search bounded with lastIndexOf would silently pick the second.
  assert.equal(sanitizeSnippetHtml("a<!-- 1 --!> 2 --!> 3 -->b"), "a 2 --!&gt; 3 --&gt;b");
});

test("sanitize(sanitize(x)) === sanitize(x) over the whole corpus", () => {
  for (const input of CORPUS) {
    const once = sanitizeSnippetHtml(input);
    const twice = sanitizeSnippetHtml(once);
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(input.slice(0, 120))}`);
    // Third pass too: a two-cycle would satisfy a naive equality check on a
    // single re-run of a different pair.
    assert.equal(sanitizeSnippetHtml(twice), once, `unstable at pass 3 for ${JSON.stringify(input.slice(0, 120))}`);
  }
});

test("the output alphabet holds for every input in the corpus", () => {
  for (const input of CORPUS) {
    assertStructurallySafe(sanitizeSnippetHtml(input), JSON.stringify(input.slice(0, 120)));
  }
  // And for a few hundred mutations of it: the point is that no combination of
  // fragments produces a token outside the alphabet.
  const fragments = [
    "<b>",
    "</b>",
    '<a href="javascript:1">',
    "<script>",
    "</script>",
    "<img src=x onerror=1>",
    "<!--",
    "-->",
    "<",
    ">",
    "&",
    '"',
    "'",
    "/",
    "&#60;",
    "<svg>",
    "</svg>",
    "texte",
  ];
  let seed = 1;
  const nextIndex = (n: number): number => {
    // Deterministic LCG: a failing case has to be reproducible.
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 400; i++) {
    let input = "";
    const len = 1 + nextIndex(8);
    for (let j = 0; j < len; j++) input += fragments[nextIndex(fragments.length)];
    const once = sanitizeSnippetHtml(input);
    assertStructurallySafe(once, JSON.stringify(input));
    assert.equal(sanitizeSnippetHtml(once), once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

test("a non-string crossing IPC does not become markup", () => {
  const hostile = [null, undefined, 42, {}, [], { toString: () => "<script>alert(1)</script>" }];
  for (const value of hostile) {
    assert.equal(sanitizeSnippetHtml(value as unknown as string), "");
  }
});
