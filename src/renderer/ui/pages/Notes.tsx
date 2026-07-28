import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import type { HistoryItem, HistoryDocPayload } from "../../../shared/longform";

// Notes (wave U5). Every capture Flow has produced, readable and listenable in
// place, and downloadable into the system Downloads folder.
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

export function Notes({ s }: { s: UiStatePayload }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<HistoryDocPayload | null>(null);
  const [docFor, setDocFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<"doc" | "audio" | null>(null);

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

  useEffect(() => {
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
      <p className="sub">Every capture Flow has produced, readable and listenable in place.</p>

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

      {items === null ? (
        <p className="sub">Reading the archive...</p>
      ) : items.length === 0 ? (
        <div className="coming">
          <div>
            No captures yet. Record a meeting from the Record page and it lands here: the
            transcript, the notes, and the audio if you kept it.
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
                  </div>
                </div>

                {current?.hasAudio ? (
                  s.apiPort ? (
                    // The engine's own streaming endpoint: range requests work, so
                    // seeking works, and nothing is buffered into the renderer.
                    <audio
                      className="doc-audio"
                      controls
                      preload="none"
                      src={`http://127.0.0.1:${s.apiPort}/long/history/audio?id=${encodeURIComponent(current.id)}`}
                    />
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

                <pre className="doc-body">{shownDoc.text}</pre>
              </>
            )}
          </div>
        </div>
      )}

      <p className="sub" style={{ margin: "16px 0 0", maxWidth: "62ch" }}>
        Downloads go straight to your Downloads folder, with no dialog. Nothing is ever
        overwritten: a second download of the same capture sits beside the first.
      </p>
    </>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  const mb = n / 1048576;
  if (mb < 1) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
