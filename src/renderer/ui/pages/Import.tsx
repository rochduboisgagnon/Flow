import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  type ImportItem,
  type ImportQueueSnapshot,
} from "../../../shared/audioImport";
import { hms } from "../../../shared/longform";
import type { Section } from "../Rail";

// Import (V4 D3). Drop audio files, get the same document a live capture
// produces: notes on top of a timestamped transcript, filed in the archive.
//
// The page's contract with the engine, and the three things it must never do:
//  - It never invents progress. Every number on screen comes from the queue
//    snapshot, which the engine derives from audio actually decoded and actually
//    transcribed (plan §5.1.4). A row with no known length shows the audio
//    covered so far instead of a bar, because a bar with no denominator is an
//    animation pretending to be a measurement.
//  - It never claims the import is advancing when it is not. An import stands
//    aside while a dictation or a live recording owns the speech engine, and the
//    row SAYS so - twenty silent minutes during a meeting would otherwise read
//    as a hung app.
//  - It never suggests the source file is Flow's now. Every path here is a read;
//    the sentence at the bottom of the page is the engine's actual behaviour, not
//    reassurance (see main/audioImport.ts's rule 1).
//
// PULL, like every channel that is not the 1 Hz heartbeat: an import runs for
// minutes and nothing about it belongs in UiStatePayload.

const POLL_MS = 700;

export function Import({ go }: { go: (s: Section) => void }) {
  const [snap, setSnap] = useState<ImportQueueSnapshot | null>(null);
  const [over, setOver] = useState(false);
  // 2026-07-30: ON by default. It was off, on the reasoning that the source file
  // is untouched so a copy is redundant - true on disk, false in use: an import
  // then appeared in Notes with a transcript and no player, and "we should have
  // access to the audio AND the transcript" is the obvious expectation. The
  // source file is still never touched either way; this is about being able to
  // listen back WITHOUT leaving the app.
  const [keepAudio, setKeepAudio] = useState(true);
  const [notes, setNotes] = useState(true);
  const [refused, setRefused] = useState<Array<{ fileName: string; reason: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inFlight = useRef(false);
  const tick = useCallback(async () => {
    if (inFlight.current) return; // two overlapping polls would fight over one state
    inFlight.current = true;
    try {
      const s = await window.flowui.importState();
      if (s) setSnap(s);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  // Electron's default action for a file dropped anywhere in a window is to
  // NAVIGATE to it (the main window refuses that navigation, but the cursor
  // still promises a drop that will not happen). Swallowing it at the document
  // level while this page is open is what makes the drop target the only place
  // a file can land - and it is undone on unmount, so no other page inherits it.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  const add = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const r = await window.flowui.importStart({ paths, keepAudio, notes });
        setRefused(r.rejected ?? []);
        if (!r.ok && (r.rejected ?? []).length === 0) {
          setError(r.error ?? "Flow could not start that import.");
        }
        await tick();
      } finally {
        setBusy(false);
      }
    },
    [keepAudio, notes, tick],
  );

  async function browse() {
    const paths = await window.flowui.importPick();
    // An empty answer is a cancelled dialog: nothing to say, nothing to clear.
    if (paths.length > 0) await add(paths);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    // Electron removed File.path (32+), so the path behind a dropped File comes
    // from webUtils in the preload. Anything that is not a real file (dragged
    // text, a browser URL) answers "" and is dropped here rather than sent on.
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.flowui.pathForFile(f))
      .filter((p) => p.length > 0);
    if (paths.length === 0) {
      setError("That was not a file Flow can read. Drop an audio file, or use Browse files.");
      return;
    }
    void add(paths);
  }

  async function act(item: ImportItem) {
    // ONE channel for both gestures, because the engine treats them as one:
    // an active import is cancelled, a finished row is dismissed (see
    // main/audioImport.ts's cancel()). Either way the row changes on screen,
    // which is the point - a control that does nothing visible is a defect.
    await window.flowui.importCancel(item.id);
    await tick();
  }

  const items = snap?.items ?? [];
  const exts = SUPPORTED_AUDIO_EXTENSIONS.map((e) => e.slice(1)).join(", ");

  return (
    <>
      <h2>Import</h2>
      <p className="sub">
        Drop audio files, get notes. Phone memos, downloaded recordings, any common format. Flow
        reads the file and writes its own document; your file is never moved, renamed or changed.
      </p>

      {error ? <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{error}</p> : null}

      <div
        className={"drop" + (over ? " over" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <svg viewBox="0 0 24 24">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <div className="hint">Drop audio here</div>
        <div className="fmts">
          {exts}. Or{" "}
          <button className="linkish" disabled={busy} onClick={() => void browse()}>
            browse files
          </button>
        </div>
      </div>

      <div className="import-opts">
        <label className="rec-keep">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
          <span>
            Write meeting notes
            <span className="sub" style={{ display: "block", margin: 0 }}>
              Off leaves the timestamped transcript alone. Notes need a local model; without one
              you get the transcript either way.
            </span>
          </span>
        </label>
        <label className="rec-keep">
          <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} />
          <span>
            Keep a copy of the audio
            <span className="sub" style={{ display: "block", margin: 0 }}>
              Lets you listen back inside Flow, beside the transcript. Your own file is never
              touched either way.
            </span>
          </span>
        </label>
      </div>
      <p className="sub" style={{ margin: "8px 0 0", fontSize: 12.4 }}>
        Both apply to what you add next, not to what is already in the queue.
      </p>

      {refused.length > 0 ? (
        <div className="note-legacy" style={{ marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            {refused.map((r) => (
              <div key={r.fileName + r.reason}>{r.reason}</div>
            ))}
          </div>
          <button className="btn ghost" onClick={() => setRefused([])}>
            Dismiss
          </button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="sub" style={{ margin: "18px 0 0", maxWidth: "62ch" }}>
          Nothing in the queue. One file at a time, and a dictation always goes first.
          Finished imports land in Notes.
        </p>
      ) : (
        <div className="queue">
          {items.map((i) => (
            <Row key={i.id} item={i} onAct={() => void act(i)} onSeeNotes={() => go("notes")} />
          ))}
        </div>
      )}
    </>
  );
}

function Row({ item, onAct, onSeeNotes }: { item: ImportItem; onAct(): void; onSeeNotes(): void }) {
  const done = item.phase === "done";
  const over = done || item.phase === "failed" || item.phase === "cancelled";
  // A bar needs a denominator. Without a known length the row states the audio
  // it has covered instead - honest, and still a number that moves.
  const showBar = !over && item.durationMs > 0;
  return (
    <div className="card qitem">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="nm">{item.fileName}</div>
        <div className={"meta" + (item.waitingFor ? " waiting" : "")}>{meta(item)}</div>
        {showBar ? (
          <div className="qbar">
            <i style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
        ) : null}
        {item.error ? (
          <div className="meta" style={{ marginTop: 6, color: "var(--err)" }}>{item.error}</div>
        ) : null}
      </div>
      <div className="qacts">
        {/* The archive is where the document actually is. Notes lists the newest
            capture first, so the one just filed is the one already open. */}
        {done || item.partial ? (
          <button className="btn ghost" onClick={onSeeNotes}>
            See it in Notes
          </button>
        ) : null}
        <button className="btn ghost" onClick={onAct}>
          {over ? "Dismiss" : item.phase === "queued" ? "Remove" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

/** The one line under the file name. Everything in it is a fact the engine
 * reported: the phase, the audio covered, and - when the import is standing
 * aside - which of the two things that outrank it has the engine. */
function meta(i: ImportItem): string {
  if (i.waitingFor) {
    return i.waitingFor === "dictation"
      ? "Paused: your dictation has the speech engine. It resumes on its own."
      : "Paused: a recording has the speech engine. It resumes when the recording ends.";
  }
  const len = i.durationMs > 0 ? hms(i.durationMs) : "";
  const covered = i.processedMs > 0 ? hms(i.processedMs) : "";
  switch (i.phase) {
    case "queued":
      return "Waiting its turn" + (len ? ` - ${len}` : "");
    case "reading":
      return "Reading the file" + (len ? ` - ${len}` : "");
    case "transcribing":
      return len
        ? `Transcribing ${Math.round(i.progress * 100)}% - ${covered} of ${len}`
        : `Transcribing - ${covered || "starting"} so far`;
    case "notes":
      return "Writing the notes" + (len ? ` - ${len}` : "");
    case "filing":
      return "Filing it in Notes";
    case "done":
      return `Done${len ? ` - ${len}` : ""}. It is in Notes.`;
    case "cancelled":
      return i.partial
        ? `Cancelled after ${covered}. The document was kept and says it is partial.`
        : "Cancelled. Nothing was written.";
    case "failed":
      return i.partial
        ? `Stopped after ${covered}. The document was kept and says it is partial.`
        : "Not imported. Nothing was written.";
  }
}
