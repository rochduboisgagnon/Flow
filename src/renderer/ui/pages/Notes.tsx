import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import { MAX_HISTORY_ITEMS, type HistoryItem, type HistoryDocPayload } from "../../../shared/longform";
import { parseTranscriptPassages, planRedaction, hms, type TranscriptPassage } from "../../../shared/redact";

// Notes (wave U5). The captures in Flow's own recordings folder, readable and
// listenable in place, and downloadable into the system Downloads folder.
//
// Three rules shape this page:
//  - PULL-only, and NOT cached. Home's "last capture" card reads a 15 s cache
//    on purpose (it keeps synchronous disk work off the keyboard hook's verdict
//    path); the archive must be exact, so it reads the live listing instead.
//  - The audio plays through the engine's OWN streaming endpoint on 127.0.0.1,
//    which supports range requests - so seeking works and a 500 MB wav is never
//    loaded into the renderer. No custom protocol, and the renderer never sees
//    a filesystem path.
//  - Downloads go straight to the Downloads folder with no dialog, like a
//    browser. The weight is on the button BEFORE the click: a wav is ~115 MB
//    per hour, and that is something to learn before, not after.

// The engine pushes a state snapshot every second WHILE the window is visible,
// and one immediately on every show/restore - and nothing at all while it is
// hidden (main/uiBridge.ts, main/index.ts's setOnShow). So a gap comfortably
// longer than one tick, measured on arrival, means the window was away and has
// just come back. That is the whole re-show detector: no new channel, no new
// poll. Erring high costs at most one extra listing on a stuttering push.
const PUSH_GAP_MS = 2_500;

export function Notes({ s }: { s: UiStatePayload }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<HistoryDocPayload | null>(null);
  const [docFor, setDocFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<"doc" | "audio" | null>(null);
  const [audioError, setAudioError] = useState(false);
  // D11: the removal mode. `picked` holds passage indices, `confirming` is the
  // second step - a destroy this permanent never happens on one click, and the
  // confirmation names the exact text and time ranges rather than asking a bare
  // "are you sure" (shared/redact.ts, DECISION 4).
  const [removing, setRemoving] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  // D8: which passage a citation click just jumped to, so the destination is
  // visibly the destination. Cleared on a new selection like everything else.
  const [jumped, setJumped] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const passageRefs = useRef(new Map<number, HTMLDivElement>());

  const refresh = useCallback(async () => {
    const list = await window.flowui.historyList();
    setItems(list);
    setSelected((cur) => (cur && list.some((i) => i.id === cur) ? cur : (list[0]?.id ?? null)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Review U5d: the list used to be read ONCE, at mount. A recording that
  // finished while this page stayed open never appeared, and nothing in the UI
  // let the user ask again. The state snapshot already tells us when a
  // recording stops, so the archive re-reads itself exactly then - and only
  // then, because a full listing is real disk work and the main process
  // carries the keyboard hook. There is also an explicit Refresh, for the
  // captures that arrive from the tray, the local API or a rescue at boot.
  const wasRecording = useRef(false);
  useEffect(() => {
    if (wasRecording.current && !s.recording) void refresh();
    wasRecording.current = s.recording;
  }, [s.recording, refresh]);

  // Review U5, MAJEUR 5: the trigger above cannot fire for the capture the user
  // was NOT watching. Both push channels are visibility-gated, so a hidden
  // window sees nothing: not a recording started from the tray, not it
  // stopping. Reopen the window after a meeting and the archive was still the
  // one from before it - a capture that exists on disk, missing from the page
  // that claims to list them.
  //
  // So the page also re-reads itself when it comes back into view, detected
  // from the arrival gap in that same push stream (see PUSH_GAP_MS): the app
  // already pushes a snapshot on show, and this turns it into the refresh
  // signal without adding a channel or a second poll.
  const lastPushMs = useRef(0);
  useEffect(() => {
    const now = Date.now();
    const cameBack = lastPushMs.current !== 0 && now - lastPushMs.current > PUSH_GAP_MS;
    lastPushMs.current = now;
    if (cameBack) void refresh();
  }, [s, refresh]);

  useEffect(() => {
    // A new selection is a new player: whatever the last one failed at is not
    // this one's state (MAJEUR 6).
    setAudioError(false);
    // D11: and a new selection is a new document. A pick list that survived the
    // switch would aim indices parsed from capture A at capture B - main would
    // refuse it (the startMs check), but offering the click at all is the bug.
    setRemoving(false);
    setPicked([]);
    setConfirming(false);
    // D8: a highlight and a passage-element map that survived the switch would
    // point into the previous document.
    setJumped(null);
    passageRefs.current.clear();
    if (!selected) {
      setDoc(null);
      setDocFor(null);
      return;
    }
    let cancelled = false;
    void window.flowui
      .historyDoc(selected)
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
        setDocFor(selected);
        if (!d) setError("Flow could not read that transcript. The file may have been moved.");
        else setError(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Titles only, and the label says so: full-text search across transcripts is
  // a later wave, and a box that silently searches less than it looks like it
  // does is the same dishonesty as a dead control.
  const shown = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.title.toLowerCase().includes(q));
  }, [items, query]);

  const current = items?.find((i) => i.id === selected) ?? null;
  // Review U5d: the document on screen must belong to the capture the buttons
  // and the player point at. `doc` lagged one selection behind while the next
  // one loaded, so the page showed A's transcript above B's player and B's
  // download buttons. `docFor` is what makes them one thing again.
  const shownDoc = docFor === selected ? doc : null;

  // D11: the removable passages of the transcript on screen, parsed by the
  // SAME pure function main will act on (shared/redact.ts). That sharing is the
  // point: what the confirmation shows and what main destroys are one reading
  // of one document, not two parsers that can drift.
  const passages = useMemo(
    () => (shownDoc ? parseTranscriptPassages(shownDoc.text) : []),
    [shownDoc],
  );
  // Everything above the first timestamped line - the header, and the derived
  // notes when there are any. Shown as-is above the passage list so the page
  // never looks like it lost half the document on entering removal mode.
  const preamble = useMemo(() => {
    if (!shownDoc) return "";
    return shownDoc.text.slice(0, passages.length > 0 ? passages[0].from : shownDoc.text.length);
  }, [shownDoc, passages]);
  // What the removal WOULD do, computed here so the confirmation can name the
  // notes block before it disappears. `dateIso` is irrelevant to these two
  // fields; main stamps the tombstone with its own clock.
  const plan = useMemo(() => {
    if (!shownDoc || picked.length === 0) return null;
    const p = planRedaction(shownDoc.text, picked, {
      hasAudio: current?.hasAudio === true,
      dateIso: "",
    });
    return "error" in p ? null : p;
  }, [shownDoc, picked, current?.hasAudio]);

  // D8: the passage every VERIFIED citation can point at, keyed by its stamp.
  // Built from the passages of the document ACTUALLY ON SCREEN, which is the
  // whole guarantee: readHistoryDoc caps its read at 5 MB, so a citation into the
  // tail of a very long transcript may name a passage this page does not hold.
  // Such a citation is rendered as plain text, never as a button - a control that
  // scrolls nowhere is a defect, and "cannot show you the source" is the honest
  // answer, not a click that appears to work and does nothing.
  const passageByStamp = useMemo(() => {
    const m = new Map<string, TranscriptPassage>();
    for (const p of passages) {
      const s = hms(p.startMs);
      if (!m.has(s)) m.set(s, p); // the first passage at a stamp wins, as the citation was copied from it
    }
    return m;
  }, [passages]);

  /** Jump to the transcript passage a citation names - and to that moment of the
   * audio when this capture kept some. Seeking is a bare `currentTime` write on
   * the player already mounted above: the engine's streaming endpoint answers
   * range requests, so this costs one small ranged GET and no new plumbing. It is
   * guarded rather than assumed - a player that is absent, or that has not been
   * given a source yet, simply does not move, and the transcript jump still
   * happens. */
  function jumpTo(p: TranscriptPassage) {
    setJumped(p.index);
    passageRefs.current.get(p.index)?.scrollIntoView({ block: "center" });
    const el = audioRef.current;
    if (el) {
      try {
        el.currentTime = p.startMs / 1000;
      } catch {
        /* no source loaded yet: the transcript jump above is the answer that matters */
      }
    }
  }

  function togglePassage(index: number) {
    setConfirming(false); // any change to the selection invalidates the confirmation
    setPicked((cur) => (cur.includes(index) ? cur.filter((i) => i !== index) : [...cur, index].sort((a, b) => a - b)));
  }

  function leaveRemoval() {
    setRemoving(false);
    setPicked([]);
    setConfirming(false);
  }

  async function removePassages() {
    if (!current || !shownDoc || picked.length === 0 || working) return;
    setWorking(true);
    setNote(null);
    setError(null);
    try {
      // The start offset the USER saw travels with each index: if the document
      // changed under us between this parse and this click, main refuses rather
      // than destroy a passage nobody looked at (see main/redact.ts).
      const targets = picked.map((i) => ({ index: i, startMs: passages[i].startMs }));
      const r = await window.flowui.redactPassages(current.id, targets);
      if (r.ok) {
        setNote(
          "Passage removed." +
            (r.audioSilenced ? " The matching audio was silenced." : " This capture kept no audio.") +
            (r.notesDropped ? " The meeting notes were removed with it." : ""),
        );
        leaveRemoval();
        // Re-read from disk rather than patch the copy on screen: after a
        // destructive write the page must show what the file actually says.
        const fresh = await window.flowui.historyDoc(current.id);
        setDoc(fresh);
        setDocFor(current.id);
        await refresh();
      } else {
        setError(r.error ?? "Flow could not remove that passage.");
        setConfirming(false);
      }
    } finally {
      setWorking(false);
    }
  }

  async function download(kind: "doc" | "audio") {
    // Review U5d: no re-entrance guard and no feedback at all during a copy
    // that can run for a minute on a 500 MB wav - the page looked frozen, and
    // a second click started a second copy that would land as "(1)".
    if (!current || downloading) return;
    setDownloading(kind);
    setNote(null);
    setError(null);
    try {
      const r = kind === "doc"
        ? await window.flowui.downloadDoc(current.id)
        : await window.flowui.downloadAudio(current.id);
      if (r.ok && r.path) setNote(`Saved to ${r.path}`);
      else setError(r.error ?? "Flow could not save that file.");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <>
      <h2>Notes</h2>
      {/* Review U5, MAJEUR 4: this used to read "Every capture Flow has
          produced", which the engine cannot honour - listHistory() stops at
          MAX_HISTORY_ITEMS (shared/longform.ts) and says so only in the log.
          Both halves of the fix are here: the promise is now the one the page
          can keep, and when the cap is actually reached the page says how many
          it is showing instead of letting the older ones vanish silently. */}
      <p className="sub">The captures in Flow&apos;s recordings folder, readable and listenable in place.</p>

      {error ? <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{error}</p> : null}
      {note ? (
        <p className="note-saved">
          <span className="mono">{note}</span>
          <button className="btn ghost" onClick={() => void window.flowui.openPath("downloaded-file")}>
            Show in folder
          </button>
        </p>
      ) : null}

      {/* U5, honouring the TODO(U5) the previous wave left on this page's stub:
          this list shows the FIXED history folder only. A user who had chosen
          their own folder before the setting was removed would otherwise see an
          archive that looks empty while their meetings sit untouched elsewhere.
          Same honesty rule as Settings > Storage: claim the files are there only
          when main has actually looked, and no Open button when they are not. */}
      {s.legacyHistory ? (
        <p className="note-legacy">
          Captures made before the recordings folder was fixed are not in this list. They are
          {s.legacyHistory.exists ? " still in " : " no longer where Flow last saw them: "}
          <span className="mono">{s.legacyHistory.dir}</span>
          {s.legacyHistory.exists ? ", untouched." : ". Flow never moved or deleted them."}
          {s.legacyHistory.exists ? (
            <button className="btn ghost" onClick={() => void window.flowui.openPath("legacy-history")}>
              Open the old folder
            </button>
          ) : null}
        </p>
      ) : null}

      {items !== null && items.length >= MAX_HISTORY_ITEMS ? (
        <p className="note-legacy">
          This list stops at the {MAX_HISTORY_ITEMS} most recent captures. The older ones are
          untouched in the recordings folder.
          <button className="btn ghost" onClick={() => void window.flowui.openPath("history")}>
            Open the recordings folder
          </button>
        </p>
      ) : null}

      {items === null ? (
        <p className="sub">Reading the archive...</p>
      ) : items.length === 0 ? (
        <div className="coming">
          <div>
            {/* "in this folder", not a flat "no captures": a user whose old
                recordings sit in a folder they chose themselves has plenty of
                captures, and the note above says where they are (MAJEUR 5). */}
            No captures in Flow&apos;s recordings folder yet. Record a meeting from the Record
            page and it lands here: the transcript, the notes, and the audio if you kept it.
          </div>
        </div>
      ) : (
        <div className="notes-grid">
          <div className="note-list">
            <div className="note-search">
              <input
                type="text"
                value={query}
                aria-label="Search titles"
                placeholder="Search titles"
                onChange={(e) => setQuery(e.target.value)}
                style={{ minWidth: 0, flex: 1 }}
              />
              <button className="btn ghost" aria-label="Refresh the archive" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
            {shown.length === 0 ? (
              <p className="sub" style={{ margin: "4px 2px 0" }}>No title matches that.</p>
            ) : null}
            {shown.map((i) => (
              <button
                key={i.id}
                className={"card note-item" + (i.id === selected ? " sel" : "")}
                aria-current={i.id === selected ? "true" : undefined}
                onClick={() => setSelected(i.id)}
              >
                <div className="nt">{i.title}</div>
                <div className="d">
                  {i.date}
                  {i.hasAudio ? ` - audio ${formatBytes(i.audioBytes)}` : ""}
                </div>
              </button>
            ))}
          </div>

          <div className="card doc">
            {!selected ? (
              <p className="sub" style={{ margin: 0 }}>Pick a capture on the left.</p>
            ) : !shownDoc ? (
              <p className="sub" style={{ margin: 0 }}>Opening...</p>
            ) : (
              <>
                <div className="doc-head">
                  <div>
                    <div className="doc-title">{shownDoc.title}</div>
                    <div className="d">{shownDoc.date}</div>
                  </div>
                  <div className="doc-actions">
                    <button className="btn" disabled={downloading !== null} onClick={() => void download("doc")}>
                      {downloading === "doc" ? "Saving..." : "Download notes"}
                    </button>
                    {current?.hasAudio ? (
                      <button className="btn" disabled={downloading !== null} onClick={() => void download("audio")}>
                        {downloading === "audio"
                          ? `Saving ${formatBytes(current.audioBytes)}...`
                          : `Download audio (${formatBytes(current.audioBytes)})`}
                      </button>
                    ) : null}
                    {/* D11. Offered only when there is something to remove: a
                        transcript with no timestamped passage (a rescued
                        recording that never got one) would put up a control
                        that opens an empty list. */}
                    {passages.length > 0 ? (
                      removing ? (
                        <button className="btn ghost" disabled={working} onClick={leaveRemoval}>
                          Done removing
                        </button>
                      ) : (
                        <button className="btn ghost" onClick={() => setRemoving(true)}>
                          Remove a passage
                        </button>
                      )
                    ) : null}
                  </div>
                </div>

                {current?.hasAudio ? (
                  s.apiPort ? (
                    // The engine's own streaming endpoint: range requests work, so
                    // seeking works, and nothing is buffered into the renderer.
                    <>
                      <audio
                        ref={audioRef}
                        className="doc-audio"
                        controls
                        preload="none"
                        src={`http://127.0.0.1:${s.apiPort}/long/history/audio?id=${encodeURIComponent(current.id)}`}
                        // Review U5, MAJEUR 6: <audio> reports every failure -
                        // a port that moved, a file purged since this list was
                        // read, a CSP that stopped allowing media-src - through
                        // this event and NOWHERE else. Without it the control
                        // just sat there doing nothing when pressed, which is a
                        // dead control wearing the costume of a live one.
                        onError={() => setAudioError(true)}
                        onPlaying={() => setAudioError(false)}
                      />
                      {audioError ? (
                        <p className="note-err" style={{ margin: "8px 0 0" }}>
                          Flow could not play that audio. Its local service may have restarted on
                          another port (Diagnostics shows its state), or the file may have moved
                          since this list was read. Refresh re-reads the archive; the download
                          button reads the file directly.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    // Review U5d: the player used to vanish without a word when
                    // the local API held no port. The audio exists; saying so
                    // beats a silently missing control, and Download still works.
                    <p className="sub" style={{ margin: "14px 0 0" }}>
                      Playback needs Flow&apos;s local service, which is not listening right now.
                      Diagnostics shows its state. You can still download the audio.
                    </p>
                  )
                ) : null}

                {removing ? (
                  <Removal
                    passages={passages}
                    preamble={preamble}
                    picked={picked}
                    onToggle={togglePassage}
                    hasAudio={current?.hasAudio === true}
                    notesWillDrop={plan?.notesDropped === true}
                    confirming={confirming}
                    working={working}
                    onAsk={() => setConfirming(true)}
                    onCancel={() => setConfirming(false)}
                    onConfirm={() => void removePassages()}
                  />
                ) : (
                  // D8: the document, with the notes block's verified citations
                  // turned into jumps and the transcript split into addressable
                  // passages. Rendered as a <div> of pre-wrap blocks rather than
                  // one <pre> because a citation has to have somewhere to scroll
                  // TO; the text itself is unchanged and still selectable.
                  <div className="doc-body">
                    {preamble ? (
                      <Citations text={preamble} resolve={(s) => passageByStamp.get(s)} onJump={jumpTo} />
                    ) : null}
                    {passages.map((p) => (
                      <div
                        key={p.index}
                        ref={(el) => {
                          if (el) passageRefs.current.set(p.index, el);
                          else passageRefs.current.delete(p.index);
                        }}
                        className={"doc-passage" + (jumped === p.index ? " jumped" : "")}
                      >
                        {p.text}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <p className="sub" style={{ margin: "16px 0 0", maxWidth: "62ch" }}>
        Downloads go straight to your Downloads folder, with no dialog. Nothing is ever
        overwritten: a second download of the same capture sits beside the first. A download
        cut short - by a crash, an update or a shutdown - never leaves a half file under the
        finished name.
      </p>
    </>
  );
}

/** D11: the removal view of one transcript. Every claim it makes is one the
 * engine actually keeps - the audio IS silenced, the notes DO go, and there is
 * genuinely no copy anywhere (shared/redact.ts's four decisions). Wording that
 * softened any of those would be the failure mode this whole feature exists to
 * avoid: a false assurance is worse than no feature. */
function Removal(props: {
  passages: TranscriptPassage[];
  preamble: string;
  picked: number[];
  onToggle(index: number): void;
  hasAudio: boolean;
  notesWillDrop: boolean;
  confirming: boolean;
  working: boolean;
  onAsk(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { passages, preamble, picked, hasAudio, notesWillDrop, confirming, working } = props;
  const chosen = passages.filter((p) => picked.includes(p.index));
  return (
    <div className="redact">
      <p className="sub" style={{ margin: "14px 0 0", maxWidth: "72ch" }}>
        Pick the passages to remove. The text goes from this transcript
        {hasAudio
          ? ", and the matching stretch of the audio is silenced so the words cannot be played back either."
          : ". This capture kept no audio file, so there is none to silence."}{" "}
        The timestamps of everything else stay exactly as they are, so the rest of the
        transcript still lines up with the recording. There is no undo, and Flow keeps no copy.
      </p>

      {preamble.trim() ? <pre className="doc-body redact-pre">{preamble}</pre> : null}

      <div className="redact-list">
        {passages.map((p) => {
          const on = picked.includes(p.index);
          return (
            <label key={p.index} className={"redact-row" + (on ? " on" : "")}>
              <input
                type="checkbox"
                checked={on}
                disabled={working}
                onChange={() => props.onToggle(p.index)}
                aria-label={`Remove the passage at ${hms(p.startMs)}`}
              />
              <span className="redact-text">{p.text.trim()}</span>
            </label>
          );
        })}
      </div>

      <div className="redact-foot">
        <p className="sub" style={{ margin: 0, maxWidth: "62ch" }}>
          {picked.length === 0 ? (
            "Nothing selected yet."
          ) : (
            <>
              {chosen.length} passage{chosen.length > 1 ? "s" : ""} selected
              {hasAudio ? (
                <>
                  {" "}
                  - the audio will be silenced from{" "}
                  {chosen
                    .map((p) => `${hms(p.startMs)} to ${p.endMs === null ? "the end of the recording" : hms(p.endMs)}`)
                    .join(", ")}
                  {chosen.some((p) => p.endMs === null) ? (
                    <>
                      {" "}
                      <b>
                        One of them is the last passage of the transcript, which names no end, so the
                        audio is silenced all the way to the end of the file - including anything after
                        it that was never transcribed.
                      </b>
                    </>
                  ) : null}
                </>
              ) : null}
              .
              {notesWillDrop ? (
                <>
                  {" "}
                  <b>
                    The meeting notes above will be removed too: they were written from this
                    transcript and could repeat what you are erasing. The transcript keeps everything
                    you did not select.
                  </b>
                </>
              ) : null}
              {confirming ? (
                <>
                  {" "}
                  <b>This cannot be undone. Flow keeps no copy of the text or of the audio.</b>
                </>
              ) : null}
            </>
          )}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {confirming ? (
            <>
              <button className="btn amber" disabled={working} onClick={props.onConfirm}>
                {working ? "Removing..." : "Remove permanently"}
              </button>
              <button className="btn ghost" disabled={working} onClick={props.onCancel}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn ghost" disabled={picked.length === 0 || working} onClick={props.onAsk}>
              Remove selected
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  const mb = n / 1048576;
  if (mb < 1) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** D8: renders a notes block with its timestamp citations turned into jumps.
 *
 * The rule this component exists to enforce is written above `passageByStamp`,
 * and it is the honest half of the feature: a citation only becomes a BUTTON
 * when it resolves to a passage that really exists in this transcript. One that
 * resolves to nothing stays plain text, because a control that scrolls nowhere
 * is a defect, and a note that offered a click for a provenance it cannot show
 * would be claiming a source it does not have.
 *
 * The text itself is never rewritten - only wrapped - so the document a user
 * reads here is byte-for-byte the document on disk, and still selectable.
 */
function Citations({
  text,
  resolve,
  onJump,
}: {
  text: string;
  resolve: (stamp: string) => TranscriptPassage | undefined;
  onJump: (p: TranscriptPassage) => void;
}) {
  // [hh:mm:ss] anywhere in a line, matching the recorder's own stamp shape (see
  // STAMP_RE in shared/redact.ts, which is anchored because it parses line
  // starts; here a citation sits mid-sentence).
  const parts: Array<string | { stamp: string; passage: TranscriptPassage }> = [];
  const re = /\[(\d{2}:\d{2}:\d{2})\]/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const passage = resolve(m[1]);
    if (passage) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push({ stamp: m[1], passage });
      last = m.index + m[0].length;
    }
    // No else: an unresolved stamp is deliberately left inside the surrounding
    // text slice, so it renders as the plain characters the document contains.
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <div className="doc-pre">
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <button
            key={i}
            className="cite"
            title={`Jump to ${p.stamp} in the transcript`}
            onClick={() => onJump(p.passage)}
          >
            [{p.stamp}]
          </button>
        ),
      )}
    </div>
  );
}
