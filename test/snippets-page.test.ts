import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sanitizeSnippetHtml } from "../src/shared/htmlSanitize";

// U3g (review, blocking): the snippet editor's preview rendered the RAW source
// the user typed or pasted through dangerouslySetInnerHTML, before any
// sanitizing (which runs in main, on write). innerHTML does not execute a
// <script>, but it does run inline handlers and it does fetch subresources -
// and this is the window that holds window.flowui.
//
// Read from source rather than rendered: there is no React test renderer in
// this project (and no DOM), so the structural fact - every
// dangerouslySetInnerHTML on the page is fed by sanitizeSnippetHtml - is what
// is asserted, plus the behaviour that fact buys, below.
const PAGE = fs.readFileSync(
  path.join(__dirname, "..", "src", "renderer", "ui", "pages", "Snippets.tsx"),
  "utf8",
);

test("the page imports the same pure sanitizer main uses", () => {
  assert.match(PAGE, /import \{ sanitizeSnippetHtml \} from "\.\.\/\.\.\/\.\.\/shared\/htmlSanitize"/);
});

test("every dangerouslySetInnerHTML on the page is fed sanitized HTML", () => {
  const sinks = [...PAGE.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim());
  assert.ok(sinks.length >= 2, "expected at least the library card preview and the editor preview");
  for (const expr of sinks) {
    assert.ok(
      expr.startsWith("sanitizeSnippetHtml(") || expr === "preview",
      `raw HTML reaches innerHTML here: __html: ${expr}`,
    );
  }
  // "preview" is the memoized editor value; check it is the sanitizer's output
  // and not just a well-named variable holding the raw draft.
  assert.match(PAGE, /const preview = useMemo\(\(\) => sanitizeSnippetHtml\(draft\.html \?\? ""\), \[draft\.html\]\)/);
});

test("the note under the preview no longer tells the user to save and reopen", () => {
  // The preview IS the sanitized result now, so the old wording ("Save and
  // reopen to see exactly what was kept") described a product that no longer
  // exists - and it was the sentence that made the raw preview look intentional.
  assert.ok(!PAGE.includes("Save and reopen"));
});

test("what the preview buys: the payloads innerHTML would have executed come out inert", () => {
  const hostile = [
    '<img src=x onerror="window.flowui.snippetDelete(1)">',
    "<svg><animate onbegin=alert(1) attributeName=x dur=1s></svg>",
    '<body onload="alert(1)">hi</body>',
    '<a href="javascript:alert(1)">click</a>',
  ];
  for (const src of hostile) {
    const out = sanitizeSnippetHtml(src);
    assert.ok(!/on[a-z]+\s*=/i.test(out), `an inline handler survived: ${out}`);
    assert.ok(!/javascript:/i.test(out), `a javascript: URL survived: ${out}`);
  }
});
