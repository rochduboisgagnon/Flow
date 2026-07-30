import React, { useEffect, useMemo, useState } from "react";
import type {
  FunctionTestResult,
  VoiceFunction,
  VoiceFunctionInput,
  VoiceFunctionsResult,
} from "../../../shared/ipcContracts";
import { PARAM_PLACEHOLDER, knownLanguageTargets, MIN_PAYLOAD_WORDS } from "../../../shared/functions";
import { Toggle } from "../components";

// Functions (wave V5, E5). Say a trigger at the head of an utterance and Flow
// transforms everything after it.
//
// Two things this page must say honestly, because the campaign counts a page
// that describes the engine wrongly as a blocking defect:
//
//  1. WHERE THE PROCESSING HAPPENS. On Ollama, over loopback - local in the
//     sense that matters (nothing leaves the machine) but NOT the embedded model
//     the plan calls D6, which is not built. So the availability line is read
//     LIVE from the engine (flowui.ollamaModels(), the same answer the engine
//     itself gets) instead of being written into the page. When Ollama is not
//     running, the page says so and says what happens instead - the raw words
//     land - because that is what the code does.
//  2. WHEN A TRIGGER FIRES, AND WHEN IT DOES NOT. The gates live in
//     shared/functions.ts and the page never restates them from memory: the dry
//     run below calls the ENGINE and shows the engine's own verdict, including
//     the sentence naming the gate that refused (explainNoMatch, exported beside
//     the gate that produces it).
//
// PULL-only, like the dictionary and snippets: the library never rides the 1 Hz
// state snapshot.

interface Draft extends VoiceFunctionInput {
  id: string;
}

const EMPTY: Draft = { id: "", name: "", enabled: true, triggers: [], instruction: "", model: "" };

export function Functions() {
  const [items, setItems] = useState<VoiceFunction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [triggerText, setTriggerText] = useState("");
  /** null = not asked yet, [] = Ollama answered with no installed model,
   * undefined-as-"down" is carried by `llmDown`. Three states, three sentences. */
  const [models, setModels] = useState<string[] | null>(null);
  const [llmDown, setLlmDown] = useState(false);

  function apply(r: VoiceFunctionsResult) {
    setItems(r.items);
    setError(r.ok ? null : (r.error ?? "Something went wrong."));
  }

  useEffect(() => {
    void window.flowui.funcList().then(apply);
    // The SAME probe the engine uses to decide whether a function can run at
    // all. null means Ollama did not answer.
    void window.flowui.ollamaModels().then((m) => {
      setLlmDown(m === null);
      setModels(m ?? []);
    });
  }, []);

  async function save() {
    if (!draft) return;
    const triggers = triggerText
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    apply(await window.flowui.funcSave({ ...draft, id: draft.id || undefined, name: draft.name.trim(), triggers }));
    setDraft(null);
    setTriggerText("");
  }

  async function toggle(f: VoiceFunction) {
    apply(await window.flowui.funcSave({ ...f, id: f.id, enabled: !f.enabled }));
  }

  async function remove(f: VoiceFunction) {
    apply(await window.flowui.funcDelete(f.id));
  }

  function edit(f: VoiceFunction) {
    setDraft({ id: f.id, name: f.name, enabled: f.enabled, triggers: f.triggers, instruction: f.instruction, model: f.model });
    setTriggerText(f.triggers.join("\n"));
  }

  const enabledCount = items?.filter((f) => f.enabled).length ?? 0;

  return (
    <>
      <h2>Functions</h2>
      <p className="sub">
        Say a trigger at the start of an utterance and Flow transforms everything after it. If the
        model fails, your raw words land anyway.
      </p>

      {error ? <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{error}</p> : null}

      {draft ? (
        <Editor
          draft={draft}
          setDraft={setDraft}
          triggerText={triggerText}
          setTriggerText={setTriggerText}
          models={models ?? []}
          onSave={() => void save()}
          onCancel={() => { setDraft(null); setTriggerText(""); }}
        />
      ) : (
        <>
          <Backend models={models} llmDown={llmDown} enabledCount={enabledCount} />

          {items === null ? (
            <p className="sub">Reading your functions...</p>
          ) : items.length === 0 ? (
            <p className="sub">
              You have no functions. A function is a spoken order that rewrites what follows it:
              &quot;translate this into English&quot;, &quot;write an email&quot;, &quot;summarize this&quot;.
            </p>
          ) : (
            <div className="fx-grid">
              {items.map((f) => (
                <div key={f.id} className={"card fx" + (f.enabled ? "" : " off")}>
                  <header>
                    <span className="nm">{f.name}</span>
                    <Toggle on={f.enabled} onChange={() => void toggle(f)} label={`Enable ${f.name}`} />
                  </header>
                  <p className="desc">{f.instruction}</p>
                  <div className="chips">
                    {f.triggers.map((t) => (
                      <span key={t} className="chip">{t}</span>
                    ))}
                  </div>
                  <div className="snip-actions">
                    <button className="btn ghost" onClick={() => edit(f)}>Edit</button>
                    <button className="btn ghost" onClick={() => void remove(f)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button className="btn amber" onClick={() => setDraft({ ...EMPTY })}>Create a function</button>
          </div>

          <DryRun />

          <p className="sub" style={{ margin: "18px 0 0", maxWidth: "64ch" }}>
            A trigger only counts at the very beginning of an utterance, and only when what follows it
            is real content - at least {MIN_PAYLOAD_WORDS} words, separated from the order by a pause
            (a colon, a comma, a full stop) unless the trigger already ends on its target, like
            &quot;translate this into English&quot;. Everything else is dictation and lands untouched.
            That asymmetry is deliberate: a missed order costs you a second, and text rewritten
            without being asked costs you what you said.
          </p>
        </>
      )}
    </>
  );
}

/** Where the processing comes from, read from the engine rather than asserted.
 * Three states, three sentences, and none of them uses the word "embedded". */
function Backend({ models, llmDown, enabledCount }: { models: string[] | null; llmDown: boolean; enabledCount: number }) {
  return (
    <div className="card" style={{ marginBottom: 16, maxWidth: "72ch" }}>
      <span className="lbl">Where a transformation runs</span>
      {models === null ? (
        <p className="sub" style={{ margin: "6px 0 0" }}>Asking the local model host...</p>
      ) : llmDown ? (
        <p className="sub" style={{ margin: "6px 0 0" }}>
          <b>Ollama is not answering on 127.0.0.1:11434</b>, so no function can run right now. Nothing
          breaks: a trigger still fires, the transformation is skipped, and your words are inserted
          exactly as dictated. Install or start Ollama to turn these on.
        </p>
      ) : models.length === 0 ? (
        <p className="sub" style={{ margin: "6px 0 0" }}>
          Ollama is running but has <b>no model installed</b>, so no function can run yet. Pull one
          (for example <span className="mono">ollama pull llama3.1:8b</span>) and it will be used
          automatically.
        </p>
      ) : (
        <p className="sub" style={{ margin: "6px 0 0" }}>
          On <b>Ollama, over loopback</b> (127.0.0.1:11434) - {models.length} model
          {models.length === 1 ? "" : "s"} installed. Nothing leaves this machine. This is not an
          embedded model: Flow does not ship one yet, so functions depend on Ollama being installed,
          and they say so rather than failing quietly.
        </p>
      )}
      <p className="sub" style={{ margin: "8px 0 0" }}>
        {enabledCount === 0
          ? "Every function ships turned off. Nothing is ever transformed until you turn one on."
          : `${enabledCount} function${enabledCount === 1 ? "" : "s"} enabled. Only enabled functions are ever listened for.`}
      </p>
    </div>
  );
}

/** E5's dry run: paste text, see what a dictation of it would produce - without
 * speaking, and without inserting anything anywhere. It calls the ENGINE, so
 * what it shows is what would really happen. */
function DryRun() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<FunctionTestResult | null>(null);

  async function run() {
    setBusy(true);
    setRes(null);
    try {
      setRes(await window.flowui.funcTest(text));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 18, maxWidth: "72ch" }}>
      <span className="lbl">Try it without speaking</span>
      <p className="sub" style={{ margin: "6px 0 10px" }}>
        Type what you would have said, trigger included. This runs the same detection, the same
        prompt and the same model as a real dictation - and inserts nothing anywhere.
      </p>
      <textarea
        className="snip-src"
        value={text}
        aria-label="Text to test"
        placeholder={`Traduis ceci en anglais : bonjour, le contrat est signe.`}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
        <button className="btn" disabled={busy || text.trim().length === 0} onClick={() => void run()}>
          {busy ? "Running..." : "Run it"}
        </button>
        {busy ? <span className="sub">A local model can take a few seconds.</span> : null}
      </div>

      {res ? (
        <div style={{ marginTop: 14 }}>
          {res.error ? (
            <p className="note-err">{res.error}</p>
          ) : (
            <>
              <p className="sub" style={{ margin: "0 0 6px" }}>
                {res.transformed ? (
                  <>
                    <b>{res.matched?.functionName}</b> ran{res.ms !== undefined ? ` in ${res.ms} ms` : ""}
                    {res.matched?.param ? ` (target: ${res.matched.param})` : ""}. This would be
                    inserted:
                  </>
                ) : (
                  <>{res.reason} This would be inserted:</>
                )}
              </p>
              {res.matched && !res.transformed ? (
                <p className="sub" style={{ margin: "0 0 6px" }}>
                  Trigger recognized: <span className="chip">{res.matched.trigger}</span>
                </p>
              ) : null}
              <pre className="tl-raw" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{res.text}</pre>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Editor({ draft, setDraft, triggerText, setTriggerText, models, onSave, onCancel }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  triggerText: string;
  setTriggerText: (s: string) => void;
  models: string[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const triggers = useMemo(
    () => triggerText.split("\n").map((t) => t.trim()).filter((t) => t.length > 0),
    [triggerText],
  );
  const usesParam = triggers.some((t) => t.includes(PARAM_PLACEHOLDER));
  const canSave = draft.name.trim().length > 0 && triggers.length > 0 && draft.instruction.trim().length > 0;
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <div className="rows">
        <div className="row">
          <div className="l">
            <b>Name</b>
            <span>What this function is called on this page. It is never spoken.</span>
          </div>
          <div className="c">
            <input
              type="text"
              value={draft.name}
              aria-label="Name"
              placeholder="Turn into actions"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
        </div>

        <div className="row">
          <div className="l">
            <b>Enabled</b>
            <span>A disabled function is inert: Flow does not even listen for its triggers.</span>
          </div>
          <div className="c">
            <Toggle on={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Enabled" />
          </div>
        </div>
      </div>

      <div className="snip-edit" style={{ marginTop: 14 }}>
        <div>
          <span className="lbl">Triggers, one per line</span>
          <textarea
            className="snip-src"
            value={triggerText}
            aria-label="Triggers"
            placeholder={`transforme en taches\nturn this into actions`}
            onChange={(e) => setTriggerText(e.target.value)}
          />
          <p className="sub" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
            Accents and capitals do not matter. Write <span className="mono">{PARAM_PLACEHOLDER}</span>{" "}
            where a target language is spoken, as in{" "}
            <span className="mono">traduis ceci en {PARAM_PLACEHOLDER}</span>. A trigger that ends on{" "}
            <span className="mono">{PARAM_PLACEHOLDER}</span> or on a word like &quot;ceci&quot; /
            &quot;this&quot; needs no pause after it; any other trigger does.
          </p>
        </div>
        <div>
          <span className="lbl">Instruction</span>
          <textarea
            className="snip-src"
            value={draft.instruction}
            aria-label="Instruction"
            placeholder="Turn the input into a list of action items, one per line."
            onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
          />
          <p className="sub" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
            What the model is told to do with what you said. Flow already appends the rules that keep
            it from chatting, inventing facts or changing the language.
            {usesParam ? (
              <>
                {" "}Use <span className="mono">{PARAM_PLACEHOLDER}</span> here too and it is replaced
                by the language you spoke ({knownLanguageTargets().length} are recognized).
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="rows" style={{ marginTop: 14 }}>
        <div className="row">
          <div className="l">
            <b>Model</b>
            <span>
              Leave empty to use the local AI model set in Settings. A bigger model translates better;
              a smaller one answers faster.
            </span>
          </div>
          <div className="c">
            <select
              value={models.includes(draft.model) ? draft.model : ""}
              aria-label="Model"
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            >
              <option value="">Same as Settings</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <button className="btn amber" disabled={!canSave} onClick={onSave}>
          {draft.id ? "Save changes" : "Create function"}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      {!canSave ? (
        <p className="sub" style={{ margin: "10px 0 0", fontSize: 11.5 }}>
          A function needs a name, at least one trigger, and an instruction.
        </p>
      ) : null}
    </div>
  );
}
