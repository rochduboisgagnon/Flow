import React, { useCallback, useEffect, useRef, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import type { LongStateSnapshot } from "../../../shared/longform";
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

type Source = "mic" | "system" | "both";

export function Record({ s }: { s: UiStatePayload }) {
  const [snap, setSnap] = useState<LongStateSnapshot | null>(null);
  const [source, setSource] = useState<Source>("both");
  const [keepAudio, setKeepAudio] = useState(true);
  const [title, setTitle] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef(0);
  const tailRef = useRef<HTMLDivElement | null>(null);

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
  const tick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const st = await window.flowui.longState();
      setSnap(st);
      const running = st.active || st.finalizing;
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
  }, []);

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

  // Review U4c: "System audio" (the PC's sound WITHOUT the microphone) is
  // refused by the engine unconditionally, because the capture window asks for
  // the microphone whatever we do - so recording "system only" would silently
  // record the mic too. The engine is right to refuse; the page was wrong to
  // offer the choice as if it worked. It is now visibly unavailable, with the
  // reason, instead of a button that always fails. The day the capture window
  // can drop the mic, this constant goes away with it.
  const SYSTEM_ONLY_UNAVAILABLE = "Recording the PC's sound without your microphone is not possible yet: the capture always includes the mic.";

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await window.flowui.longStart({ source, title: title.trim() || undefined, keepAudio });
      if (!r.ok) setError(r.error ?? "Flow could not start the recording.");
      else {
        setTranscript("");
        sinceRef.current = 0;
      }
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
          <div className="card">
            <span className="lbl">Source</span>
            <div className="seg" style={{ marginTop: 9 }} role="group" aria-label="Audio source">
              <SourceButton id="mic" label="Microphone" cur={source} set={setSource} disabled={active || !nativeReady} />
              <SourceButton
                id="system"
                label="System audio"
                cur={source}
                set={setSource}
                disabled
                title={SYSTEM_ONLY_UNAVAILABLE}
              />
              <SourceButton id="both" label="Both" cur={source} set={setSource} disabled={active || !nativeReady} />
            </div>
            <p className="sub" style={{ margin: "9px 0 0" }}>
              {!nativeReady
                ? "Recording the PC's own audio needs Windows. On this system Flow cannot capture it, so long recordings are unavailable."
                : "Both mixes what the PC plays with your microphone. No bot joins the call."}
            </p>
            {nativeReady ? (
              <p className="sub" style={{ margin: "6px 0 0", fontSize: 11.5 }}>{SYSTEM_ONLY_UNAVAILABLE}</p>
            ) : null}
          </div>

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
              <Ribbon strandCount={6} width={360} height={52} cssWidth={180} cssHeight={26} />
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
                Start a recording and the transcript appears here, line by line, as the engine
                works through it. It is written to disk at the same time, so nothing depends on
                this window staying open.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function SourceButton({ id, label, cur, set, disabled, title }: {
  id: Source;
  label: string;
  cur: Source;
  set: (s: Source) => void;
  disabled: boolean;
  title?: string;
}) {
  return (
    <button
      className={cur === id ? "on" : ""}
      disabled={disabled}
      title={title}
      aria-pressed={cur === id}
      aria-disabled={disabled || undefined}
      onClick={() => set(id)}
    >
      {label}
    </button>
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
