import React, { useEffect, useMemo, useState } from "react";
import type { DictEntry, DictInput, DictKind } from "../../../shared/ipcContracts";
import { promptTerms } from "../../../shared/dictionary";

// Dictionary (wave U6). Teach the engine the names, acronyms and jargon it
// keeps getting wrong.
//
// The page has to make ONE distinction clear, because everything else follows
// from it: a VOCABULARY term biases the model before it decodes, so the word
// simply comes out right; a REPLACEMENT rewrites what the model produced, so
// it only fires on the exact wrong spellings you list. The first is gentler
// and never touches a transcript; the second is deterministic and can rewrite
// a word you meant. The wording below says that instead of assuming it.
//
// PULL-only, like snippets and the archive: the library never rides the state
// snapshot pushed every second.

const EMPTY: DictInput & { id: string } = {
  id: "",
  term: "",
  aliases: [],
  kind: "vocabulary",
  starred: false,
};

export function Dictionary() {
  const [items, setItems] = useState<DictEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<(DictInput & { id: string }) | null>(null);
  const [aliasText, setAliasText] = useState("");
  const [query, setQuery] = useState("");

  function apply(r: { ok: boolean; items: DictEntry[]; error?: string }) {
    setItems(r.items);
    setError(r.ok ? null : (r.error ?? "Something went wrong."));
  }

  useEffect(() => {
    void window.flowui.dictList().then(apply);
  }, []);

  async function save() {
    if (!draft) return;
    const aliases = aliasText
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    apply(await window.flowui.dictSave({ ...draft, id: draft.id || undefined, term: draft.term.trim(), aliases }));
    setDraft(null);
    setAliasText("");
  }

  async function toggleStar(e: DictEntry) {
    apply(await window.flowui.dictSave({ ...e, starred: !e.starred }));
  }

  async function remove(e: DictEntry) {
    apply(await window.flowui.dictDelete(e.id));
  }

  function edit(e: DictEntry) {
    setDraft({ id: e.id, term: e.term, aliases: e.aliases, kind: e.kind, starred: e.starred });
    setAliasText(e.aliases.join(", "));
  }

  const shown = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.term.toLowerCase().includes(q) || i.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }, [items, query]);

  // Count what the engine ACTUALLY receives, by calling the very function that
  // builds the prompt - never `items.filter(starred).length`. The budget can
  // drop the tail of a long starred list, and those two numbers part company
  // exactly when it matters. (This is the mistake this page already made once.)
  const sent = promptTerms(items ?? []).length;
  const starred = items?.filter((i) => i.starred).length ?? 0;

  return (
    <>
      <h2>Dictionary</h2>
      <p className="sub">
        Teach the engine your names, acronyms and jargon. Only starred terms are told to it before it
        listens; everything else is fixed after the fact.
      </p>

      {error ? <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{error}</p> : null}

      {draft ? (
        <Editor
          draft={draft}
          setDraft={setDraft}
          aliasText={aliasText}
          setAliasText={setAliasText}
          onSave={() => void save()}
          onCancel={() => { setDraft(null); setAliasText(""); }}
        />
      ) : (
        <>
          <div className="dict-add">
            <input
              type="text"
              value={query}
              aria-label="Search the dictionary"
              placeholder="Search a term or a spelling"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="btn amber" onClick={() => setDraft({ ...EMPTY })}>Add a term</button>
          </div>

          {items === null ? (
            <p className="sub">Reading your dictionary...</p>
          ) : shown.length === 0 ? (
            <p className="sub">{query ? "Nothing matches that." : "Your dictionary is empty."}</p>
          ) : (
            <div className="dict">
              {shown.map((e) => (
                <div key={e.id} className="card drow">
                  <span className="term">{e.term}</span>
                  {e.aliases.length > 0 ? (
                    <>
                      <span className="arrow" aria-hidden="true">&#8592;</span>
                      {e.aliases.map((a) => (
                        <span key={a} className="chip">{a}</span>
                      ))}
                    </>
                  ) : null}
                  <span className="kind">{e.kind === "replacement" ? "replacement" : "vocabulary"}</span>
                  <button
                    className={"star" + (e.starred ? "" : " off")}
                    aria-label={e.starred ? `Unstar ${e.term}` : `Star ${e.term}`}
                    aria-pressed={e.starred}
                    onClick={() => void toggleStar(e)}
                  >
                    {e.starred ? "★" : "☆"}
                  </button>
                  <button className="btn ghost" onClick={() => edit(e)}>Edit</button>
                  <button className="btn ghost" onClick={() => void remove(e)}>Delete</button>
                </div>
              ))}
            </div>
          )}

          {/* Review U6/U7 (blocking, mine): this used to claim that ONLY starred
              terms reach the engine and that everything else "works after the
              fact". Both were false - the prompt takes starred terms first and
              then fills the remaining budget with the others. Writing a claim
              about the engine without reading the engine is exactly the failure
              this campaign hunts elsewhere. The wording now describes what the
              star actually does: it decides the ORDER, and the order decides
              who fits. */}
          <p className="sub" style={{ margin: "18px 0 0", maxWidth: "64ch" }}>
            {sent < starred
              ? `${sent} of your ${starred} starred terms are sent to the engine before it listens. The rest do not fit in that short list.`
              : `${sent} starred ${sent === 1 ? "term is" : "terms are"} sent to the engine before it listens.`}{" "}
            That list is deliberately short: telling the model about too many words makes it write
            words nobody said, which is worse than the mistake it fixes. Replacements work after the
            fact, starred or not, and cost nothing.
          </p>
        </>
      )}
    </>
  );
}

function Editor({ draft, setDraft, aliasText, setAliasText, onSave, onCancel }: {
  draft: DictInput & { id: string };
  setDraft: (d: DictInput & { id: string }) => void;
  aliasText: string;
  setAliasText: (s: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const isReplacement = draft.kind === "replacement";
  const canSave =
    draft.term.trim().length > 0 && (!isReplacement || aliasText.trim().length > 0);
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="rows">
        <div className="row">
          <div className="l">
            <b>Term</b>
            <span>The correct spelling, exactly as it should end up in your text.</span>
          </div>
          <div className="c">
            <input
              type="text"
              value={draft.term}
              aria-label="Term"
              placeholder="Loi 25"
              onChange={(e) => setDraft({ ...draft, term: e.target.value })}
            />
          </div>
        </div>

        <div className="row">
          <div className="l">
            <b>How it works</b>
            <span>
              {isReplacement
                ? "Rewrites the spellings below after the engine has transcribed. Deterministic, and it only ever fires on what you list."
                : "Tells the engine about the word before it listens, so it comes out right on its own. Never rewrites your transcript."}
            </span>
          </div>
          <div className="c">
            <select
              value={draft.kind}
              aria-label="How it works"
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as DictKind })}
            >
              <option value="vocabulary">Vocabulary</option>
              <option value="replacement">Replacement</option>
            </select>
          </div>
        </div>

        <div className="row">
          <div className="l">
            <b>{isReplacement ? "Wrong spellings to fix" : "Wrong spellings (not used here)"}</b>
            <span>
              {isReplacement
                ? "What the engine writes instead, separated by commas. Each of these gets rewritten to the term. They are never sent to the engine: teaching it a misspelling would only make it write it more often."
                : "A vocabulary term does not rewrite anything, so these are kept for reference only and change nothing. Switch to Replacement above if you want them corrected."}
            </span>
          </div>
          <div className="c">
            <input
              type="text"
              value={aliasText}
              aria-label="Wrong spellings"
              placeholder="loi vingt-cinq, loi 25 du quebec"
              onChange={(e) => setAliasText(e.target.value)}
            />
          </div>
        </div>

        <div className="row">
          <div className="l">
            <b>Starred</b>
            <span>
              Starred terms go into the short list the engine hears about before it listens. A
              vocabulary term that is not starred does nothing: that list is the only way a
              vocabulary term acts.
            </span>
          </div>
          <div className="c">
            <button
              className={"star" + (draft.starred ? "" : " off")}
              aria-label="Starred"
              aria-pressed={draft.starred}
              onClick={() => setDraft({ ...draft, starred: !draft.starred })}
            >
              {draft.starred ? "★" : "☆"}
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <button className="btn amber" disabled={!canSave} onClick={onSave}>
          {draft.id ? "Save changes" : "Add to dictionary"}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      {isReplacement && aliasText.trim().length === 0 ? (
        <p className="sub" style={{ margin: "10px 0 0", fontSize: 13.8 }}>
          A replacement needs at least one wrong spelling to look for.
        </p>
      ) : null}
    </div>
  );
}
