import React, { useCallback, useEffect, useRef, useState } from "react";
import { ASSIST_WAIT_TEXT, type AssistSnapshot } from "../../shared/liveAssist";
import { hms } from "../../shared/longform";
import { Toggle } from "./components";

// U8: the live-suggestions panel, inside the Record page.
//
// It is its own module rather than a block of Record.tsx on purpose: the whole
// feature can be read, reviewed and removed in one file, and the page it lives
// in only gains an import and one element.
//
// THREE RULES THIS COMPONENT EXISTS TO ENFORCE, and none of them is styling:
//
//  1. NOTHING MOVES on its own. No animation, no transition, no auto-scroll, no
//     focus steal, no badge that pulses. The list is a stable area; it changes
//     at most once every 45 seconds, when a round completes. On this panel the
//     real cost is the eye it pulls at the exact moment attention belongs on the
//     person talking - the computation is the cheap part (plan-design §15.1).
//
//  2. IT NEVER IMPLIES REAL TIME. The engine transcribes in ~7 s segments, so
//     every item is about speech that is already some seconds old. Each one
//     therefore carries the stretch of the recording it was derived from, and
//     the footer says it in words. This is the question §15.8 says decides
//     whether the whole feature is honest.
//
//  3. A SUGGESTION IS NEVER MISTAKABLE FOR SPEECH. It lives in a separate card
//     from the transcript, every item is introduced as written by the model, and
//     the transcript is not touched unless the user presses Keep - which writes
//     a line that says "NOT spoken by anyone" before it says anything else.
//
// The poll below is also the feature's ON/OFF switch at the mechanical level:
// main owns no timer (main/liveAssist.ts), so leaving this page - or closing the
// window - stops a local model from reading the meeting, by construction.

/** Slower than the transcript's 1 Hz next door: nothing here changes faster than
 * a round, and a round is 45 s apart at best. This only has to be fast enough
 * that a press feels answered. */
const POLL_MS = 2_000;

export function LiveAssistPanel() {
  const [snap, setSnap] = useState<AssistSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // One tick. Serialized like the Record page's own tick: two overlapping polls
  // would both be answered from the same in-memory state, which is harmless, but
  // the guard also keeps the engine from being asked twice for nothing.
  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const s = await window.flowui.assistPoll();
      setSnap(s);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  async function setEnabled(on: boolean) {
    setBusy(true);
    try {
      // The setting is the single source of truth (settings.json, through the
      // one applySettings funnel). The immediate re-poll is what makes the
      // control's effect VISIBLE on the same press instead of up to two seconds
      // later: the snapshot it answers with is read from the setting that was
      // just written.
      await window.flowui.setSettings({ liveAssist: on });
      await tick();
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<AssistSnapshot>) {
    setBusy(true);
    try {
      setSnap(await fn());
    } finally {
      setBusy(false);
    }
  }

  const enabled = snap?.enabled === true;
  const recording = snap?.recording === true;

  return (
    <div className="card assist">
      <div className="assist-head">
        <div>
          <span className="lbl">Live suggestions</span>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            Off by default. When on, a model running on this machine reads the last few minutes of
            the transcript and proposes notes, questions or replies. It never types into another
            app, and nothing is added to the recording unless you keep it.
          </p>
        </div>
        <Toggle
          label="Live suggestions"
          on={enabled}
          onChange={(v) => {
            if (!busy) void setEnabled(v);
          }}
        />
      </div>

      {/* Where the suggestions REALLY come from, named rather than implied. Shown
          only when the feature is on: an off panel has no provenance to state. */}
      {enabled ? (
        <p className="assist-src">
          {snap?.model
            ? `Written by ${snap.model}, running on this computer through Ollama. Nothing about this meeting leaves the machine.`
            : "Flow does not embed its own model yet: suggestions come from Ollama running on this computer. Nothing leaves the machine either way."}
        </p>
      ) : null}

      {/* The state, always in words. A quiet panel must never look broken. */}
      {snap ? (
        <p className="assist-wait">{snap.error ? snap.error : ASSIST_WAIT_TEXT[snap.wait]}</p>
      ) : (
        <p className="assist-wait">Asking the engine...</p>
      )}

      {enabled && recording ? (
        <div className="assist-acts">
          <button
            className="btn"
            disabled={busy}
            onClick={() => void act(() => window.flowui.assistAsk())}
          >
            Suggest now
          </button>
          {snap && snap.quietRounds > 0 ? (
            <span className="chip">
              {snap.quietRounds} time{snap.quietRounds > 1 ? "s" : ""} it had nothing to say
            </span>
          ) : null}
        </div>
      ) : null}

      {snap && snap.suggestions.length > 0 ? (
        <div className="assist-list">
          {snap.suggestions.map((s) => (
            <div key={s.id} className={"assist-item" + (s.kept ? " kept" : "")}>
              {/* The attribution comes BEFORE the text, every single time. A
                  reader skimming this panel must not have to work out who wrote
                  what. */}
              <span className="assist-by">Suggested by the local model</span>
              <div className="txt">{s.text}</div>
              <div className="meta num">
                From what was said between {hms(s.contextFromMs)} and {hms(s.contextUpToMs)} of the
                recording
              </div>
              <div className="assist-acts">
                {s.kept ? (
                  <span className="chip">Kept in the document</span>
                ) : (
                  <button
                    className="btn"
                    disabled={busy || !recording}
                    title={
                      recording
                        ? "Write it into this recording's document, marked as a suggestion and not as speech"
                        : "Only while the recording is running: once it is finished, Flow does not append to its document"
                    }
                    onClick={() => void act(() => window.flowui.assistKeep(s.id))}
                  >
                    Keep in notes
                  </button>
                )}
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => void act(() => window.flowui.assistDismiss(s.id))}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {enabled ? (
        <p className="assist-foot">
          Suggestions are based on speech that has already been transcribed, so they lag the room by
          several seconds - the time shown on each one is the part of the recording it came from, not
          the present moment. They pause while you dictate or while the transcription is catching up:
          the recording always comes first. Leaving this page stops them entirely.
        </p>
      ) : null}
    </div>
  );
}
