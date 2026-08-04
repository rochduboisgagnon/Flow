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

/**
 * CE QUE LE CONTROLE DIT, SELON LE TYPE DE L'ENTREE.
 *
 * Roch, le 2026-08-04 : « a place de mettre une etoile, c'est un peu melangeant,
 * mets un bouton Enable / Disable pour que ca soit plus evident ».
 *
 * IL AVAIT RAISON SUR LE DIAGNOSTIC, ET L'ETOILE ETAIT CONFUSE POUR UNE RAISON
 * PRECISE : un seul symbole portait DEUX sens.
 *
 *   vocabulaire, etoile   -> le terme est dit au moteur avant qu'il ecoute
 *   vocabulaire, sans     -> l'entree ne fait RIEN DU TOUT (l'etage 1 est le seul
 *                            etage par lequel un terme de vocabulaire agit)
 *   remplacement, etoile  -> dit au moteur ET reecrit apres coup
 *   remplacement, sans    -> reecrit apres coup, donc IL FONCTIONNE ENCORE
 *
 * Donc « Enabled / Disabled » est vrai pour un terme de vocabulaire et FAUX pour
 * un remplacement : ecrire « Disabled » sur une ligne qui continue de reecrire le
 * texte de quelqu'un serait exactement le genre de mensonge d'interface que ce
 * depot refuse ailleurs (le bouton « Reprendre le nettoyage a 90 jours » a ete
 * supprime pour ca).
 *
 * Le libelle suit donc le type. C'est ce qui repond vraiment au « melangeant » :
 * le controle dit ce qu'il fait, la ou l'etoile demandait de se souvenir d'une
 * regle.
 */
function toggleLabel(kind: DictKind, starred: boolean): { text: string; title: string } {
  if (kind === "replacement") {
    return starred
      ? {
          text: "Also prompted",
          title: "This replacement rewrites the text after the fact, and its term is also told to the engine before it listens.",
        }
      : {
          text: "Rewrite only",
          title: "This replacement still rewrites the text after the fact. It is simply not told to the engine beforehand, which costs nothing.",
        };
  }
  return starred
    ? { text: "Enabled", title: "This term is told to the engine before it listens, which is how a vocabulary term acts." }
    : {
        text: "Disabled",
        title: "A vocabulary term that is not told to the engine does nothing at all: that short list is the only way it can act.",
      };
}

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
                    className={"dtoggle" + (e.starred ? " on" : "")}
                    aria-label={`${toggleLabel(e.kind, e.starred).text}: ${e.term}`}
                    aria-pressed={e.starred}
                    title={toggleLabel(e.kind, e.starred).title}
                    onClick={() => void toggleStar(e)}
                  >
                    {toggleLabel(e.kind, e.starred).text}
                  </button>
                  <button className="btn ghost" onClick={() => edit(e)}>Edit</button>
                  <button className="btn ghost" onClick={() => void remove(e)}>Delete</button>
                </div>
              ))}
            </div>
          )}

          {/* Review U6/U7 : cette phrase a deja ete corrigee une fois pour avoir
              decrit le moteur sans le lire.
              2026-08-04 : le commentaire qui l'accompagnait etait a son tour
              perime. Il disait « le drapeau decide l'ORDRE, et l'ordre decide qui
              rentre », ce qui etait vrai de la version ou le prompt se remplissait
              avec les termes non marques apres avoir pris les marques. Le
              constructeur les IGNORE maintenant (`promptTerms` : `if (!e.starred)
              continue`), donc le drapeau decide l'APPARTENANCE et le budget decide
              qui rentre. La phrase visible ci-dessous disait deja ca ; c'est le
              commentaire qui avait vieilli. */}
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

        {/* Le libelle ET l'explication suivent le type, pour la raison du bandeau de
            toggleLabel : « active » ne veut pas dire la meme chose pour un terme de
            vocabulaire et pour un remplacement. */}
        <div className="row">
          <div className="l">
            <b>{draft.kind === "replacement" ? "Tell the engine too" : "Enabled"}</b>
            <span>
              {draft.kind === "replacement"
                ? "This replacement rewrites the text after the fact either way, at no cost. Turning this on also puts its term in the short list the engine hears before it listens, which can help it write the word correctly in the first place."
                : "A vocabulary term acts by being in the short list the engine hears before it listens. Disabled, it does nothing at all."}
            </span>
          </div>
          <div className="c">
            <button
              className={"dtoggle" + (draft.starred ? " on" : "")}
              aria-label={toggleLabel(draft.kind, draft.starred).text}
              aria-pressed={draft.starred}
              onClick={() => setDraft({ ...draft, starred: !draft.starred })}
            >
              {toggleLabel(draft.kind, draft.starred).text}
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
        <p className="sub" style={{ margin: "10px 0 0", fontSize: 12.4 }}>
          A replacement needs at least one wrong spelling to look for.
        </p>
      ) : null}
    </div>
  );
}
