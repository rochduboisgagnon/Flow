import React, { useCallback, useEffect, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import type { StatsPayload } from "../../../shared/stats";

// Statistics (wave U7). Counters only, and the page's job is to be honest
// about that in both directions.
//
// The privacy policy behind this page was decided before a single byte was
// written (plan de design §10): aggregate counters are kept, per-application
// attribution is NOT, unless the user turns it on, and everything rolls off
// after twelve months. This page therefore never invents a demo curve to look
// alive: a fresh install shows zeros and says why, because a fabricated number
// on a page whose whole point is truthfulness would poison the rest.

const HEAT_WEEKS = 26;

export function Statistics({ s, patch }: {
  s: UiStatePayload;
  patch: (p: Record<string, unknown>) => Promise<void>;
}) {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const read = useCallback(async () => {
    setData(await window.flowui.statsRead());
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  // The counters are written from the engine, so a dictation that lands while
  // this page is open changes them. Re-read when the engine stops listening,
  // which is exactly when a new utterance has been counted.
  useEffect(() => {
    if (!s.listening) void read();
  }, [s.listening, read]);

  async function clear() {
    setData(await window.flowui.statsClear());
    setConfirmClear(false);
  }

  // Review U6/U7 (blocking, mine): the attribution buttons called patch() and
  // stopped there. patch() refreshes the ENGINE snapshot, but this page reads
  // `data.perApp`, which comes from the last statsRead() - so the panel did not
  // move, and the buttons looked broken. Every write to a stats setting has to
  // re-read the stats, because they are two different sources of truth on
  // purpose (the snapshot is a heartbeat, the payload is the data).
  async function setSetting(p: Record<string, unknown>) {
    await patch(p);
    await read();
  }

  if (!data) return <><h2>Statistics</h2><p className="sub">Reading your counters...</p></>;

  const empty = data.days.length === 0;

  return (
    <>
      <h2>Statistics</h2>
      <p className="sub">
        Counters only. Your words are never stored, so there is nothing here to leak.
      </p>

      {data.error ? <p className="note-err" style={{ marginTop: -12, marginBottom: 16 }}>{data.error}</p> : null}

      {!data.counting ? (
        // Review U6/U7 (major, mine): this used to point at a switch that did
        // not exist anywhere in the app. The switch belongs here, next to what
        // it governs, rather than on a settings tab the user would have to be
        // told about.
        <div className="coming">
          <div>
            Counting is off, so Flow keeps no figures at all. The file was deleted when you turned it
            off, and counting would start again from today.
          </div>
          <div style={{ marginTop: 14 }}>
            <button className="btn amber" onClick={() => void setSetting({ stats: true })}>
              Start counting
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="tiles">
            <div className="card tile">
              <span className="lbl">Words this month</span>
              <b className="num">{empty ? "0" : data.monthWords.toLocaleString("fr-CA")}</b>
              <span className="delta">{empty ? "nothing counted yet" : `${data.totalWords.toLocaleString("fr-CA")} in the last 12 months`}</span>
            </div>
            <div className="card tile">
              <span className="lbl">Speaking rate</span>
              <b className="num">
                {data.avgWpm > 0 ? data.avgWpm : "-"}
                {data.avgWpm > 0 ? <span style={{ fontSize: 14, color: "var(--ink2)" }}> wpm</span> : null}
              </b>
              <span className="delta">
                {data.avgWpm > 0 ? "how fast you actually speak" : "needs a dictation or two"}
              </span>
            </div>
            <div className="card tile">
              <span className="lbl">Streak</span>
              <b className="num">
                {data.streakDays}
                <span style={{ fontSize: 14, color: "var(--ink2)" }}> {data.streakDays === 1 ? "day" : "days"}</span>
              </b>
              <span className="delta">{data.streakDays > 0 ? "consecutive days with a dictation" : "dictate today to start one"}</span>
            </div>
          </div>

          <div className="stats-low">
            <div className="card">
              <span className="lbl">Activity, last 6 months</span>
              {empty ? (
                <p className="sub" style={{ margin: "12px 0 0" }}>Nothing yet. Every day you dictate lights up a square.</p>
              ) : (
                <Heatmap days={data.days} today={data.today} />
              )}
            </div>

            <div className="card">
              <span className="lbl">Where you dictate</span>
              {!data.perApp ? (
                // Not a dead control and not a fake graph: the honest reason,
                // and the switch that changes it, one screen away.
                <>
                  <p className="sub" style={{ margin: "12px 0 0" }}>
                    Flow does not record which application you were in. That is off by default:
                    a log of which app you speak into says more about your day than the words do.
                  </p>
                  <div style={{ marginTop: 12 }}>
                    <button className="btn" onClick={() => void setSetting({ statsPerApp: true })}>
                      Start recording app names
                    </button>
                  </div>
                </>
              ) : data.apps.length === 0 ? (
                <p className="sub" style={{ margin: "12px 0 0" }}>
                  On, but nothing recorded yet. It starts counting from your next dictation.
                </p>
              ) : (
                <div className="bars">
                  {data.apps.map((a) => (
                    <div className="bar" key={a.name}>
                      <div className="t">
                        <span>{a.name}</span>
                        <span className="num">{a.words.toLocaleString("fr-CA")}</span>
                      </div>
                      <div className="rail2">
                        <i style={{ width: `${Math.max(3, Math.round((a.words / data.apps[0].words) * 100))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="stats-foot">
            <p className="sub" style={{ margin: 0, maxWidth: "62ch" }}>
              <b>Two switches, two different things.</b> Counting words is what fills the tiles
              above; recording app names is what fills &ldquo;Where you dictate&rdquo;, and it is off
              until you ask for it. Stopping one does not stop the other. One line per day, nothing
              per dictation, and days older than twelve months are dropped as they age out. Either
              switch erases what it had already recorded, rather than merely stopping.
              {data.perApp ? " Application names are being recorded right now." : ""}
              {confirmStop ? (
                <>
                  {" "}
                  <b>Stopping deletes the counters already recorded, every day and the streak
                  included. There is no undo.</b>
                </>
              ) : null}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              {data.perApp ? (
                <button className="btn" onClick={() => void setSetting({ statsPerApp: false })}>
                  Stop recording applications
                </button>
              ) : null}
              {confirmStop ? (
                <>
                  <button className="btn amber" onClick={() => { setConfirmStop(false); void setSetting({ stats: false }); }}>
                    Stop and erase
                  </button>
                  <button className="btn ghost" onClick={() => setConfirmStop(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn ghost" onClick={() => setConfirmStop(true)}>Stop counting words</button>
              )}
              {confirmClear ? (
                <>
                  <button className="btn amber" onClick={() => void clear()}>Erase everything</button>
                  <button className="btn ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn ghost" disabled={empty} onClick={() => setConfirmClear(true)}>
                  Clear statistics
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Heatmap({ days, today }: { days: StatsPayload["days"]; today: string }) {
  // A real calendar, built backwards from the day main computed the tiles
  // against - never a second, possibly different, clock reading in the page.
  const byDate = new Map(days.map((d) => [d.date, d.words]));
  const peak = Math.max(...days.map((d) => d.words), 1);
  const end = new Date(today + "T00:00:00");
  const cells: Array<{ date: string; words: number }> = [];
  for (let i = HEAT_WEEKS * 7 - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const pad = (n: number) => String(n).padStart(2, "0");
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    cells.push({ date: key, words: byDate.get(key) ?? 0 });
  }
  return (
    <div className="heat" role="img" aria-label={`Dictation activity over the last ${HEAT_WEEKS} weeks`}>
      {cells.map((c) => (
        <i
          key={c.date}
          className={level(c.words, peak)}
          title={c.words > 0 ? `${c.date}: ${c.words} words` : c.date}
        />
      ))}
    </div>
  );
}

function level(words: number, peak: number): string {
  if (words <= 0) return "";
  const share = words / peak;
  if (share > 0.66) return "l3";
  if (share > 0.33) return "l2";
  return "l1";
}
