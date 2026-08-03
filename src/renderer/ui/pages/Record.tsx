import React, { useCallback, useEffect, useRef, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import type { LongStateSnapshot } from "../../../shared/longform";
import { hms } from "../../../shared/longform";
import { MAX_NOTE_CHARS, type LiveNote } from "../../../shared/liveNotes";
import { Ribbon } from "../Ribbon";

// Record (wave U4). Drive a long-form recording from the app instead of from
// the phone: pick the source, watch the transcript grow, mark a moment, stop.
//
// State discipline, deliberately different from the rest of the window:
//  - The recorder's state is PULL, never in UiStatePayload. That snapshot is
//    pushed every second to every page; a transcript in it would re-render the
//    whole window once a second and turn a heartbeat into a data bus.
//  - This page polls ONLY while it is mounted AND something is happening. A
//    page nobody is looking at must cost the engine nothing - the main process
//    carries the keyboard hook, and every millisecond spent here is a
//    millisecond the push-to-talk verdict waits.
//  - The transcript is fetched INCREMENTALLY (`since` -> `nextSince`), so a
//    two-hour meeting never re-transfers its document once a second.

const POLL_MS = 1000;

export function Record({ s }: { s: UiStatePayload }) {
  const [snap, setSnap] = useState<LongStateSnapshot | null>(null);
  // The capture is always "both": see the note where the selector used to be.
  const [keepAudio, setKeepAudio] = useState(true);
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef(0);
  const tailRef = useRef<HTMLDivElement | null>(null);
  // D7: the notes the user types during the recording. `notesFor` is which
  // recording the list belongs to, straight from the engine's answer - the page
  // renders nothing unless it matches the capture on screen, so notes from the
  // previous meeting can never appear under this one (shared/liveNotes.ts's
  // LiveNotesResult).
  const [notes, setNotes] = useState<LiveNote[]>([]);
  const [notesFor, setNotesFor] = useState("");
  const [draft, setDraft] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  // One tick: the state snapshot, plus the transcript increment while a
  // recording is ACTIVE. Both are cheap; neither touches the disk in a loop.
  //
  // Review U4c, three separate defects fixed here:
  //  - A tick used to fire only when the state we ALREADY had said "active",
  //    so the refresh condition was the very data the refresh produces: once
  //    idle, the page never asked again. A recording started from the tray or
  //    the local API stayed invisible, and Start stayed clickable. The state
  //    snapshot is now polled UNCONDITIONALLY while this page is mounted; it
  //    is one cheap in-memory call, and the page is only mounted while someone
  //    is looking at it.
  //  - Ticks could overlap: two in flight both read the same `since` and both
  //    appended the same increment. A single in-flight guard serializes them.
  //  - The transcript is NOT polled during `finalizing`: finalize() rewrites
  //    the whole document (header + summary + transcript), so a byte offset
  //    into the old document is meaningless and would duplicate text. The
  //    finished document is read once, whole, when the recorder goes idle.
  const inFlight = useRef(false);
  const wasRunning = useRef(false);
  // Review U4 (major): which recording the byte offset in sinceRef belongs to.
  // It used to be reset only by this page's own start(), so a recording started
  // anywhere else - the tray, the local API, a connector - kept the PREVIOUS
  // recording's offset and appended the new transcript onto the old text, at an
  // offset that means nothing in the new document. startedIso identifies the
  // capture and, unlike docPath, does not change when finalize() files the
  // document into the archive mid-flight.
  const recordingRef = useRef("");
  // D7: PULLED, and deliberately NOT on the 1 Hz tick. Reading the slot is a
  // synchronous JSON read in the main process - the process that carries the
  // keyboard hook - so it happens when the list can actually have changed: on
  // mount, when the recording identity changes, and as the answer to every write
  // (each channel returns the whole list, so the page never patches its own copy
  // and drifts from disk).
  const refreshNotes = useCallback(async () => {
    const r = await window.flowui.liveNotesList();
    setNotes(r.notes);
    setNotesFor(r.startedIso);
    setNoteError(r.ok ? null : (r.error ?? null));
  }, []);

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const st = await window.flowui.longState();
      setSnap(st);
      const running = st.active || st.finalizing;
      if (st.startedIso !== recordingRef.current) {
        // A different recording than the one on screen: start from zero, before
        // any increment is fetched against a stale offset.
        recordingRef.current = st.startedIso;
        sinceRef.current = 0;
        setTranscript("");
        wasRunning.current = false;
        // D7: a different capture is a different set of notes. Same single
        // mechanism as the transcript offset above, and for the same reason a
        // whole review finding was spent on it: a recording started from the
        // tray or the local API must reset this page's idea of what it is
        // annotating, not only one started by this page's own button.
        setDraft("");
        setEditing(null);
        await refreshNotes();
      }
      if (st.active) {
        const inc = await window.flowui.longTranscript(sinceRef.current);
        if (inc.text) {
          setTranscript((t) => t + inc.text);
          sinceRef.current = inc.nextSince;
        }
      } else if (wasRunning.current && !running) {
        // The recorder just finished. finalize() rewrote the document (header,
        // summary, transcript), so the incremental view we built is stale by
        // construction: read the finished document ONCE, whole, and replace it.
        const whole = await window.flowui.longTranscript(0);
        setTranscript(whole.text);
        sinceRef.current = whole.nextSince;
      }
      wasRunning.current = running;
    } finally {
      inFlight.current = false;
    }
  }, [refreshNotes]);

  useEffect(() => {
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  // Keep the newest line in view without fighting a user who scrolled up.
  useEffect(() => {
    const el = tailRef.current;
    if (!el) return;
    const box = el.parentElement;
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (nearBottom) el.scrollIntoView({ block: "end" });
  }, [transcript]);

  const active = snap?.active === true;
  const finalizing = snap?.finalizing === true;

  // The one honest reason a source can be unavailable, straight from the
  // engine: without native capture there is no way to feed this machine's
  // audio into a long recording at all.
  const nativeReady = s.canLoopback;


  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await window.flowui.longStart({ source: "both", title: title.trim() || undefined, keepAudio });
      if (!r.ok) setError(r.error ?? "Flow could not start the recording.");
      // No transcript reset here: the tick below sees a new startedIso and does
      // it. ONE mechanism, which is the point - this page's own start() being
      // the only thing that ever reset the offset is exactly how a recording
      // begun from the tray or the API ended up appended to the previous one.
      await tick();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await window.flowui.longStop();
      await tick();
    } finally {
      setBusy(false);
    }
  }

  async function mark() {
    await window.flowui.longMark();
    await tick();
  }

  // ---- D7: the note panel's three gestures ----
  // Each one names the recording it is aimed at (`snap.startedIso`) and takes the
  // WHOLE list back. Nothing is written while the user types - a note reaches the
  // disk when it is committed, and only then (shared/liveNotes.ts DECISION 1).

  function absorb(r: { ok: boolean; startedIso: string; notes: LiveNote[]; error?: string }) {
    setNotes(r.notes);
    setNotesFor(r.startedIso);
    setNoteError(r.ok ? null : (r.error ?? "Flow could not record that note."));
    return r.ok;
  }

  async function commitNote() {
    const text = draft.trim();
    if (!text || !snap?.active) return;
    if (absorb(await window.flowui.liveNoteAdd(snap.startedIso, text))) setDraft("");
  }

  async function saveEdit() {
    if (!editing || !snap) return;
    const text = editing.text.trim();
    if (!text) return;
    if (absorb(await window.flowui.liveNoteEdit(snap.startedIso, editing.id, text))) setEditing(null);
  }

  async function deleteNote(id: string) {
    if (!snap) return;
    absorb(await window.flowui.liveNoteDelete(snap.startedIso, id));
    if (editing?.id === id) setEditing(null);
  }

  return (
    <>
      <h2>Record</h2>
      <p className="sub">Capture a meeting from this PC. The transcript grows on disk as you speak.</p>

      {error ? <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{error}</p> : null}
      {snap?.lastError ? (
        <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{snap.lastError}</p>
      ) : null}

      <div className="rec-wrap">
        <div className="rec-side">
          {/* 2026-07-30: the SOURCE selector is gone, asked for directly. It
              offered Microphone / System audio / Both, with "System audio"
              permanently disabled because the capture always includes the mic -
              so the real choice was between "mic only" and "everything", and
              nobody wants a meeting recorded without the other half of it.
              Flow now captures the PC's sound AND your microphone, always. */}
          <div className="card">
            <span className="lbl">This recording</span>
            <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                type="text"
                value={active ? snap?.title ?? "" : title}
                disabled={active || finalizing}
                aria-label="Recording title"
                placeholder="Weekly product sync"
                onChange={(e) => setTitle(e.target.value)}
                style={{ minWidth: 0, width: "100%" }}
              />
              <label className="rec-keep">
                <input
                  type="checkbox"
                  checked={keepAudio}
                  disabled={active || finalizing}
                  onChange={(e) => setKeepAudio(e.target.checked)}
                />
                <span>
                  Keep the audio file
                  <span className="sub" style={{ display: "block", margin: 0 }}>
                    Lets you listen back later. The transcript is written either way.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="card rec-pill">
            <div className="pill-shell">
              {/* Review U4 (major): only a LIVE capture animates. This is the
                  same visual language as the dictation overlay's "I hear you"
                  indicator, so a full-amplitude ribbon above the word "Idle"
                  was the app claiming to be listening when it was not. */}
              <Ribbon strandCount={6} width={360} height={52} cssWidth={180} cssHeight={26} active={active} />
            </div>
            <div className="rec-time num">{formatDuration(snap?.durationMs ?? 0)}</div>
            <div className="rec-meta">
              {active || finalizing ? (
                <>
                  <span>{snap?.segments ?? 0} transcribed</span>
                  {(snap?.pending ?? 0) > 0 ? <span>{snap?.pending} queued</span> : null}
                  {(snap?.marks ?? 0) > 0 ? <span>{snap?.marks} marked</span> : null}
                </>
              ) : (
                <span>Idle</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              {active ? (
                <>
                  <button className="btn" disabled={busy} onClick={() => void mark()}>Mark this moment</button>
                  <button className="btn amber" disabled={busy} onClick={() => void stop()}>Stop</button>
                </>
              ) : finalizing ? (
                <span className="sub" style={{ margin: 0 }}>Finishing the transcript...</span>
              ) : (
                <button className="btn amber" disabled={busy || !nativeReady || s.listening} onClick={() => void start()}>
                  Start recording
                </button>
              )}
            </div>
            {s.listening && !active ? (
              <p className="sub" style={{ margin: 0, textAlign: "center" }}>
                Finish your dictation first: both use the same speech engine.
              </p>
            ) : null}
          </div>
        </div>

        <div className="rec-main">
          {/* D7: the notes the USER writes, beside the transcript the machine
              writes. Placed FIRST, above the transcript, for the same reason
              they come first in the finished document (shared/longform.ts's
              MY_NOTES_HEADING): the point of the panel is that what the human
              judged important outranks what the machine heard. */}
          <LiveNotesPanel
            active={active}
            finalizing={finalizing}
            mine={notesFor && snap && notesFor === snap.startedIso ? notes : []}
            error={noteError}
            draft={draft}
            setDraft={setDraft}
            editing={editing}
            setEditing={setEditing}
            onCommit={() => void commitNote()}
            onSaveEdit={() => void saveEdit()}
            onDelete={(id) => void deleteNote(id)}
          />

          <div className="card">
            <span className="lbl">Live transcript</span>
            <div className="transcript" style={{ marginTop: 12 }}>
              {transcript ? (
                <>
                  <pre className="tl-raw">{transcript}</pre>
                  <div ref={tailRef} />
                </>
              ) : active ? (
                <p className="sub" style={{ margin: 0 }}>Listening. The first lines appear once a segment is transcribed.</p>
              ) : (
                <p className="sub" style={{ margin: 0 }}>
                  The transcript appears here as the engine works, and is written to disk at the same time.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

    </>
  );
}

/** D7: the raw-notes panel.
 *
 * Every claim it makes is one the engine keeps. Two in particular:
 *
 *  - "written down the moment you press Enter". True, and it is why the panel is
 *    built around a commit rather than around a textarea that saves itself: one
 *    gesture, one small atomic write, nothing at all on disk while you type
 *    (shared/liveNotes.ts DECISION 1). The corollary is stated rather than
 *    hidden - the line still in the box is the one thing a crash can take.
 *  - "your words, as you typed them". True: the verbatim block in the document is
 *    never rewritten, and the model is told to fix the spelling only in ITS text
 *    (shared/longform.ts's renderMyNotes).
 *
 * The controls are live only while a recording is ACTIVE. Once it stops the notes
 * are in the document and the slot is gone, so an editable list would be a dead
 * control wearing the costume of a live one - the panel says where they went
 * instead. */
function LiveNotesPanel(props: {
  active: boolean;
  finalizing: boolean;
  mine: LiveNote[];
  error: string | null;
  draft: string;
  setDraft: (s: string) => void;
  editing: { id: string; text: string } | null;
  setEditing: (e: { id: string; text: string } | null) => void;
  onCommit: () => void;
  onSaveEdit: () => void;
  onDelete: (id: string) => void;
}) {
  const { active, finalizing, mine, error, draft, editing } = props;
  return (
    <div className="card">
      <span className="lbl">Your notes</span>
      <p className="sub" style={{ margin: "6px 0 0" }}>
        Type what matters as it happens. Your notes lead the summary, and stay in the document exactly as you wrote them.
      </p>

      {error ? <p className="note-err" style={{ margin: "10px 0 0" }}>{error}</p> : null}

      {active ? (
        <div className="ln-compose">
          <input
            type="text"
            value={draft}
            maxLength={MAX_NOTE_CHARS}
            aria-label="Write a note about this moment"
            placeholder="Marc owns the migration"
            onChange={(e) => props.setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter commits. Nothing is written before it: this keystroke is
              // the only thing in the panel that touches the disk.
              if (e.key === "Enter") {
                e.preventDefault();
                props.onCommit();
              }
            }}
            style={{ minWidth: 0, flex: 1 }}
          />
          <button className="btn" disabled={draft.trim().length === 0} onClick={props.onCommit}>
            Add note
          </button>
        </div>
      ) : null}

      {mine.length === 0 ? (
        <p className="sub" style={{ margin: "12px 0 0" }}>
          {active
            ? "Nothing yet. Each note is stamped with the moment you wrote it, so it points at what was being said right then."
            : "Start a recording and your notes go here, each stamped with the moment you wrote it."}
        </p>
      ) : (
        <div className="ln-list">
          {mine.map((n) => (
            <div key={n.id} className="ln-row">
              <span className="ln-at num">{hms(n.atMs)}</span>
              {editing?.id === n.id ? (
                <>
                  <input
                    type="text"
                    value={editing.text}
                    maxLength={MAX_NOTE_CHARS}
                    aria-label="Edit this note"
                    autoFocus
                    onChange={(e) => props.setEditing({ id: n.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        props.onSaveEdit();
                      } else if (e.key === "Escape") props.setEditing(null);
                    }}
                    style={{ minWidth: 0, flex: 1 }}
                  />
                  <button className="btn ghost" onClick={props.onSaveEdit}>Save</button>
                  <button className="btn ghost" onClick={() => props.setEditing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span className="ln-text">{n.text}</span>
                  {active ? (
                    <>
                      {/* Editing keeps the original stamp: the moment recorded is
                          when you decided this was worth writing down, and fixing
                          a typo later does not change that moment. */}
                      <button
                        className="btn ghost"
                        aria-label={`Edit the note at ${hms(n.atMs)}`}
                        onClick={() => props.setEditing({ id: n.id, text: n.text })}
                      >
                        Edit
                      </button>
                      <button
                        className="btn ghost"
                        aria-label={`Delete the note at ${hms(n.atMs)}`}
                        onClick={() => props.onDelete(n.id)}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {active ? (
        <p className="sub" style={{ margin: "10px 0 0", fontSize: 12.4 }}>
          A note is written to disk the moment you add it, so a crash or a power cut keeps every
          one of them. Only a line still sitting in the box above would be lost.
        </p>
      ) : mine.length > 0 ? (
        <p className="sub" style={{ margin: "10px 0 0", fontSize: 12.4 }}>
          {finalizing
            ? "These are going into the document now, above the notes Flow writes from the transcript."
            : "These are in the document, at the top, above the notes Flow wrote from the transcript. Open it from the Notes page."}
        </p>
      ) : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
