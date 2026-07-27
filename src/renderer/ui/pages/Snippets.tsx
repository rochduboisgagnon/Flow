import React, { useEffect, useMemo, useState } from "react";
import type { Snippet, SnippetInput, SnippetsResult } from "../../../shared/ipcContracts";
import { sanitizeSnippetHtml } from "../../../shared/htmlSanitize";
import { Toggle } from "../components";

// Snippets (wave U3). Say a cue, insert a full block - deterministic, no model.
//
// Two rules shape this page:
//  - The library is PULL-only. It never rides UiStatePayload (pushed every
//    second): this page fetches it on mount and after each write, and every
//    write answers with the WHOLE library so the list can never go stale.
//  - The plain-text fallback is STORED and user-editable, never derived at
//    paste time. CF_HTML consumers disagree (Outlook renders a <p> as a
//    paragraph break where the user expected none), so the user must SEE the
//    two renderings side by side and fix the one that lands in Notepad.
//
// No WYSIWYG on purpose: contenteditable produces browser-flavoured HTML that
// would then be sanitized back into the allowlist, so the user would edit one
// thing and store another. A textarea plus a live sanitized preview shows
// exactly what will be written.
//
// U3g (review, blocking): NOTHING on this page is rendered through
// dangerouslySetInnerHTML without going through sanitizeSnippetHtml first. The
// editor preview used to render the RAW source the user typed or pasted, before
// any sanitizing (which runs in main, on write). innerHTML does not execute a
// <script>, but it very much executes inline handlers - <img src=x onerror=...>,
// <svg><animate onbegin=...> - and it fetches subresources; and this is the one
// window that holds window.flowui. The sanitizer is a PURE module (no electron
// import, no DOM), so the renderer imports the exact same function main uses.
// Main still sanitizes on write, and that remains the guarantee: what happens
// here is defence in depth plus an honest preview, never the security boundary.

type Draft = SnippetInput & { id: string };

const EMPTY: Draft = { id: "", cue: "", enabled: true, format: "text", text: "", html: "" };

export function SnippetsPage() {
  const [items, setItems] = useState<Snippet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function apply(r: SnippetsResult) {
    setItems(r.items);
    setError(r.ok ? null : (r.error ?? "Something went wrong."));
  }

  // U3g (review): an invoke REJECTS when main throws or the channel is gone -
  // it does not answer {ok:false}. Without this, a rejection left the page on
  // "Loading your snippets..." forever with the reason only in a devtools
  // console no user opens. Every call goes through here, so a failure always
  // has a visible sentence and the list keeps whatever it last knew.
  async function run(op: () => Promise<SnippetsResult>): Promise<boolean> {
    try {
      const r = await op();
      apply(r);
      return r.ok;
    } catch (err) {
      setItems((cur) => cur ?? []);
      setError(`Flow could not reach its snippet store: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  useEffect(() => {
    void run(() => window.flowui.snippetList());
  }, []);

  async function save() {
    if (!draft) return;
    const payload: SnippetInput = {
      id: draft.id || undefined,
      cue: draft.cue.trim(),
      enabled: draft.enabled,
      format: draft.format,
      text: draft.text,
      html: draft.format === "html" ? draft.html : undefined,
    };
    // U3g (review): the draft is cleared ONLY on success. Clearing it
    // unconditionally threw away everything the user had typed the moment the
    // disk refused the write - the one moment they most need it back.
    if (await run(() => window.flowui.snippetSave(payload))) setDraft(null);
  }

  async function toggle(s: Snippet) {
    await run(() => window.flowui.snippetSave({ ...s, enabled: !s.enabled }));
  }

  async function copy(s: Snippet) {
    if (!(await run(() => window.flowui.snippetCopy(s.id)))) return;
    setCopied(s.id);
    window.setTimeout(() => setCopied((c) => (c === s.id ? null : c)), 1600);
  }

  async function remove(s: Snippet) {
    await run(() => window.flowui.snippetDelete(s.id));
  }

  return (
    <>
      <h2>Snippets</h2>
      <p className="sub">Say a cue, insert a full block. Deterministic, instant, no model involved.</p>

      {error ? <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{error}</p> : null}

      {draft ? (
        <Editor
          draft={draft}
          setDraft={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      ) : items === null ? (
        <p className="sub">Loading your snippets...</p>
      ) : items.length === 0 ? (
        <div className="coming">
          <div>No snippets yet. A snippet is a block you insert by saying its cue: a signature, a booking link, a standup template.</div>
          <div style={{ marginTop: 14 }}>
            <button className="btn amber" onClick={() => setDraft({ ...EMPTY })}>Create a snippet</button>
          </div>
        </div>
      ) : (
        <>
          <div className="fx-grid">
            {items.map((s) => (
              <div key={s.id} className={"card fx snip" + (s.enabled ? "" : " off")}>
                <header>
                  <span className="nm">
                    {s.cue || "Untitled"}
                    <span className={"fmt" + (s.format === "text" ? " plain" : "")}>
                      {s.format === "html" ? "HTML" : "Plain text"}
                    </span>
                  </span>
                  <Toggle on={s.enabled} onChange={() => void toggle(s)} label={`Enable ${s.cue}`} />
                </header>
                <p className="desc">
                  Say <span className="cue">&quot;{s.cue}&quot;</span>
                </p>
                {s.format === "html" && s.html ? (
                  // Sanitized by the MAIN process at write time, on an allowlist
                  // of a dozen inline tags - the file on disk is safe for every
                  // consumer, not just this component. Run through the same pure
                  // sanitizer again anyway (U3g): it is idempotent by
                  // construction, so this costs nothing on a file we wrote, and
                  // snippets.json is an ordinary file on disk that something
                  // else may have edited since.
                  <div className="rich" dangerouslySetInnerHTML={{ __html: sanitizeSnippetHtml(s.html) }} />
                ) : (
                  <pre>{s.text}</pre>
                )}
                <div className="snip-actions">
                  <button className="btn" onClick={() => void copy(s)}>
                    {copied === s.id ? "Copied" : "Copy to clipboard"}
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => setDraft({ id: s.id, cue: s.cue, enabled: s.enabled, format: s.format, text: s.text, html: s.html ?? "" })}
                  >
                    Edit
                  </button>
                  <button className="btn ghost" onClick={() => void remove(s)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
          <p className="sub" style={{ margin: "16px 0 0", maxWidth: "56ch" }}>
            HTML snippets paste as rich text (bold, links) in apps that accept it, and fall back to
            the plain text you wrote everywhere else. In Type insertion mode, snippets always insert
            the plain text: keystrokes cannot carry formatting.
          </p>
          <p className="sub" style={{ margin: "6px 0 0", maxWidth: "56ch" }}>
            Saying the cue out loud arrives with the dictation wave. Today the cue names the snippet,
            and Copy puts it on your clipboard.
          </p>
          <div style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => setDraft({ ...EMPTY })}>Create a snippet</button>
          </div>
        </>
      )}
    </>
  );
}

function Editor({ draft, setDraft, onSave, onCancel }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // U3g: the preview is the SANITIZED source, so it is literally what main will
  // store - the same pure function, run on the same bytes. That fixes two things
  // at once: nothing hostile in the source can execute in this window (inline
  // handlers do run under innerHTML), and the preview stops promising formatting
  // the allowlist would have stripped. Memoized on the source because it re-runs
  // on every keystroke otherwise.
  const preview = useMemo(() => sanitizeSnippetHtml(draft.html ?? ""), [draft.html]);
  const canSave = draft.cue.trim().length > 0 && draft.text.trim().length > 0;
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="rows">
        <div className="row">
          <div className="l">
            <b>Cue</b>
            <span>What names this snippet. Saying it out loud arrives with the dictation wave.</span>
          </div>
          <div className="c">
            <input
              type="text"
              value={draft.cue}
              aria-label="Cue"
              placeholder="insert my signature"
              onChange={(e) => setDraft({ ...draft, cue: e.target.value })}
            />
          </div>
        </div>
        <div className="row">
          <div className="l">
            <b>Format</b>
            <span>HTML pastes as rich text where the app accepts it. Plain text goes everywhere.</span>
          </div>
          <div className="c">
            <select
              value={draft.format}
              aria-label="Format"
              onChange={(e) => setDraft({ ...draft, format: e.target.value === "html" ? "html" : "text" })}
            >
              <option value="text">Plain text</option>
              <option value="html">HTML</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div className="l">
            <b>Enabled</b>
            <span>A disabled snippet stays in your library and does nothing.</span>
          </div>
          <div className="c">
            <Toggle on={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Enabled" />
          </div>
        </div>
      </div>

      {draft.format === "html" ? (
        <div className="snip-edit">
          <div>
            <span className="lbl">HTML source</span>
            <textarea
              className="snip-src"
              value={draft.html ?? ""}
              aria-label="HTML source"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, html: e.target.value })}
            />
          </div>
          <div>
            <span className="lbl">Preview</span>
            <div className="rich" dangerouslySetInnerHTML={{ __html: preview }} />
            <p className="sub" style={{ margin: "8px 0 0", fontSize: 11.5 }}>
              Flow keeps a small allowlist: bold, italics, underline, lists, paragraphs and links to
              http, https or mailto. Anything else is stripped, and this preview is already stripped
              - what you see here is exactly what gets saved.
            </p>
          </div>
        </div>
      ) : null}

      <div className="snip-edit" style={{ marginTop: 14 }}>
        <div style={draft.format === "html" ? undefined : { gridColumn: "1 / -1" }}>
          <span className="lbl">{draft.format === "html" ? "Plain-text fallback" : "Text"}</span>
          <textarea
            className="snip-src"
            value={draft.text}
            aria-label={draft.format === "html" ? "Plain-text fallback" : "Text"}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
          {draft.format === "html" ? (
            <p className="sub" style={{ margin: "8px 0 0", fontSize: 11.5 }}>
              What lands in Notepad, a terminal, or any app that refuses rich text. Stored as you
              write it, never guessed from the HTML.
            </p>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <button className="btn amber" disabled={!canSave} onClick={onSave}>
          {draft.id ? "Save changes" : "Create snippet"}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
