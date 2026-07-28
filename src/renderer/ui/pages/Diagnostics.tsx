import React, { useEffect, useState } from "react";
import type {
  UiStatePayload,
  SelfCheckReport,
  SelfCheckStatus,
} from "../../../shared/ipcContracts";
import {
  computeIntervals,
  evaluateBudgets,
  summarize,
  LOOP_LAG_P99_THRESHOLD_MS,
  type HotpathEventKind,
  type HotpathSnapshot,
  type HotpathSummary,
  type HotpathTrace,
} from "../../../shared/hotpath";
import { LOOP_LAG_ACTIVE_PERIOD_MS, LOOP_LAG_IDLE_PERIOD_MS } from "../../../shared/loopLag";

// Diagnostics (wave U1 restyle): same facts as before, mockup's card + table.
// Everything here is copyable (the user-select allowlist covers table.diag
// and .mono) - a diagnostic you cannot paste into a bug report is useless.
//
// B1 addition: the activation hot-path panel below. It is PULL, polled on its
// own timer (see ipcContracts.ts's module note on UI_HOTPATH_SNAPSHOT) rather
// than riding the 1 Hz UiStatePayload push - the ring can hold 200 traces
// plus thousands of raw latency samples, and most seconds nobody is even on
// this page. A snapshot is a self-consistent still frame (see hotpath.ts): all
// its timestamps share ONE performance.now() clock, so "time ago" below is
// computed against the snapshot's own `generatedAt`, never against Date.now().
// B4: the five hook states in the words a bug report needs. "abandoned" says
// what to DO about it, because it is the only one that will not fix itself.
function hookStateLabel(s: UiStatePayload): string {
  switch (s.hook.state) {
    case "armed":
      return "armed";
    case "restarting":
      return "restarting after a failure";
    case "abandoned":
      return "unavailable - Flow stopped restarting it; restart Flow";
    case "starting":
      return "starting";
    default:
      return "stopped";
  }
}

export function Diagnostics({ s }: { s: UiStatePayload }) {
  return (
    <>
      <h2>Diagnostics</h2>
      <p className="sub">What the engine is doing right now, copyable and honest.</p>
      <div className="card">
        <table className="diag">
          <tbody>
            <tr><td>App version</td><td className="num">{s.version}</td></tr>
            <tr><td>Engine status</td><td>{s.status}</td></tr>
            {/* B4: the keyboard hook's own health, counters included. Until
                this row existed, a key server that died left NOTHING behind in
                the app - the shortcut simply stopped working and every screen
                went on saying "ready". */}
            <tr><td>Keyboard hook</td><td>{hookStateLabel(s)}</td></tr>
            <tr>
              <td>Hook interruptions</td>
              <td className="mono">
                {s.hook.deaths === 0
                  ? "none this session"
                  : `${s.hook.deaths} death(s), ${s.hook.restarts} recovered`}
              </td>
            </tr>
            {s.hook.lastIncidentAt !== null ? (
              <tr>
                <td>Last hook incident</td>
                <td>
                  {new Date(s.hook.lastIncidentAt).toLocaleString()}
                  {s.hook.lastIncidentDetail ? ` - ${s.hook.lastIncidentDetail}` : ""}
                </td>
              </tr>
            ) : null}
            <tr><td>Speech backend</td><td>{s.backend || "(selecting)"}</td></tr>
            <tr><td>Model file</td><td className="mono">{s.settings.model}</td></tr>
            <tr>
              <td>Model state</td>
              <td>
                {s.modelState.status}
                {s.modelState.status === "downloading" ? ` (${s.modelState.pct ?? 0}%)` : ""}
                {s.modelState.message ? ` - ${s.modelState.message}` : ""}
              </td>
            </tr>
            <tr><td>Local API</td><td className="mono">{s.apiPort ? `127.0.0.1:${s.apiPort}, loopback only` : "(starting)"}</td></tr>
            <tr><td>System-audio capture</td><td>{s.canLoopback ? "available (Windows loopback)" : "not available on this OS"}</td></tr>
            <tr>
              <td>Data folder</td>
              <td>
                <span className="mono">{s.dataDir}</span>{" "}
                <button className="btn ghost" aria-label="Open data folder" onClick={() => void window.flowui.openPath("data")}>Open</button>
              </td>
            </tr>
            <tr>
              <td>Engine log</td>
              <td>
                <span className="mono">{s.logPath}</span>{" "}
                <button className="btn ghost" aria-label="Open engine log" onClick={() => void window.flowui.openPath("log")}>Open</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <SelfCheckPanel />
      <HotpathPanel />
    </>
  );
}

// ---- B5: the self-diagnostic ----
// On demand ONLY (button), never polled: producing the report enumerates audio
// devices through a renderer round trip and writes a probe file to disk. Every
// verdict below is decided in shared/selfCheck.ts, pure and unit-tested - this
// component chooses colours and nothing else, which is what keeps the panel and
// the startup lines in flow.log telling the same story.

const SELF_CHECK_TONE: Record<SelfCheckStatus, { dot: string; word: string }> = {
  ok: { dot: "on", word: "OK" },
  warn: { dot: "off", word: "Attention" },
  fail: { dot: "err", word: "Problem" },
  unknown: { dot: "off", word: "Not established" },
};

function SelfCheckPanel() {
  const [report, setReport] = useState<SelfCheckReport | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await window.flowui.selfCheck();
      setReport(r);
      if (!r) setErr("Flow could not run the checks.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <h3 style={{ marginTop: 28 }}>Self-check</h3>
      <p className="sub">
        Six things that have to be true for a dictation to work, each with what to do when it is not. Flow also runs
        this a few seconds after every start and writes the result to the engine log.
      </p>
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: report ? 12 : 0 }}>
          <button className="btn amber" onClick={() => void run()} disabled={running}>
            {running ? "Checking..." : "Run the checks"}
          </button>
          {report ? (
            <span className="sub" style={{ margin: 0 }}>
              <span className={"dot " + SELF_CHECK_TONE[report.worst].dot} />
              {SELF_CHECK_TONE[report.worst].word} - checked {new Date(report.generatedAtIso).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
        {err ? <p className="note-err" style={{ margin: 0 }}>{err}</p> : null}
        {report ? (
          <table className="diag" style={{ maxWidth: "none" }}>
            <tbody>
              {report.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className={"dot " + SELF_CHECK_TONE[l.status].dot} />
                    {l.label}
                  </td>
                  <td>
                    {l.detail}
                    {/* The fix is the whole point of a red line: never a colour without a next step. */}
                    {l.fix ? <div className="sub" style={{ margin: "4px 0 0" }}>{l.fix}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}

const POLL_MS = 2000;

function fmtMs(ms: number | null): string {
  return ms === null ? "-" : `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

function agoLabel(t: number | null, nowT: number): string {
  if (t === null) return "-";
  const s = (nowT - t) / 1000;
  return s < 1 ? "just now" : s < 60 ? `${s.toFixed(0)}s ago` : `${(s / 60).toFixed(1)}m ago`;
}

function traceLastT(tr: HotpathTrace): number | null {
  return tr.marks.length ? tr.marks[tr.marks.length - 1].t : null;
}

function hookEventLabel(kind: HotpathEventKind): string {
  switch (kind) {
    case "hook-died":
      return "the key server died - dictation was off from here";
    case "hook-restarted":
      return "the keyboard hook came back";
    default:
      return "Flow stopped restarting the keyboard hook";
  }
}

function outcomeLabel(tr: HotpathTrace): string {
  if (tr.outcome === "completed") return tr.result === "inserted" ? "inserted" : "clipboarded";
  if (tr.outcome === "abandoned") return `abandoned - ${tr.reason ?? "unknown"}`;
  return "in progress";
}

// One row per §3.3 budget, aggregated across every completed trace in the
// snapshot - median/p95/worst-case, the same shape `bench:hotpath` prints, so
// the panel and the CLI can never tell a different story about the same data.
interface BudgetRow {
  metric: string;
  budgetMs: number;
  measurable: boolean;
  summary: HotpathSummary;
}

function aggregateBudgets(traces: HotpathTrace[]): BudgetRow[] {
  // evaluateBudgets always returns the same 4 rows in the same order (see
  // hotpath.ts) - even for a placeholder trace with no marks at all, which is
  // exactly what lets this table show all four budgets, with "no data yet",
  // before a single press has been captured.
  // B2: all four are measurable now. The two that happen inside the overlay
  // renderer are reported by it and folded into the trace by main
  // (hotpath.markOverlayTimings), so the `measurable: false` branch below has
  // no producer left - it is kept because the distinction it draws ("Flow
  // cannot answer this" vs "nothing has produced it yet") is the right one to
  // have ready the next time a number lives somewhere this process cannot see.
  const placeholder = evaluateBudgets({ id: 0, outcome: "abandoned", marks: [] });
  const values: number[][] = placeholder.map(() => []);
  for (const tr of traces) {
    evaluateBudgets(tr).forEach((row, i) => {
      if (row.valueMs !== null) values[i].push(row.valueMs);
    });
  }
  return placeholder.map((row, i) => ({
    metric: row.metric,
    budgetMs: row.budgetMs,
    measurable: row.measurable,
    summary: summarize(values[i]),
  }));
}

function BudgetCell({ value, budgetMs, measurable }: { value: number | null; budgetMs: number; measurable: boolean }) {
  if (!measurable) return <span className="sub">not measurable from the main process alone</span>;
  if (value === null) return <span className="sub">no data yet</span>;
  const over = value >= budgetMs;
  return <span style={over ? { color: "var(--err)", fontWeight: 600 } : undefined}>{fmtMs(value)}</span>;
}

function HotpathPanel() {
  const [snap, setSnap] = useState<HotpathSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const s = await window.flowui.hotpathSnapshot();
        if (alive) {
          setSnap(s);
          setErr(s ? null : "Flow could not answer with a hot-path snapshot.");
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  if (err && !snap) return <p className="note-err" style={{ marginTop: 16 }}>{err}</p>;
  if (!snap) return <p className="sub" style={{ marginTop: 16 }}>Loading the activation hot path...</p>;

  const recent = [...snap.completed].reverse(); // most recent first
  const budgets = aggregateBudgets(snap.completed);
  const handlerLatency = summarize(snap.handlerLatenciesMs);

  return (
    <>
      <h3 style={{ marginTop: 28 }}>Activation hot path (plan V2)</h3>
      <p className="sub">
        One press = one row. Timings only, never dictated content. {snap.completed.length} traces held
        ({snap.open.length} currently in flight).
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <span className="lbl">Budgets (§3.3)</span>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table className="diag" style={{ maxWidth: "none" }}>
            <thead>
              <tr>
                <td>Metric</td><td>Budget</td><td>Median</td><td>p95</td><td>Worst case</td><td>N</td>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => (
                <tr key={b.metric}>
                  <td>{b.metric}</td>
                  <td className="mono">{b.budgetMs} ms</td>
                  <td><BudgetCell value={b.summary.medianMs} budgetMs={b.budgetMs} measurable={b.measurable} /></td>
                  <td><BudgetCell value={b.summary.p95Ms} budgetMs={b.budgetMs} measurable={b.measurable} /></td>
                  <td><BudgetCell value={b.summary.maxMs} budgetMs={b.budgetMs} measurable={b.measurable} /></td>
                  <td className="mono">{b.measurable ? b.summary.count : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <span className="lbl">Keyboard hook handler latency (every key event, not just the shortcut)</span>
        <p className="sub" style={{ margin: "6px 0 10px" }}>
          Windows silently removes a low-level hook that blocks too long. This is that same clock: the
          full synchronous cost of one hook callback, matcher and any onStart/onStop/onCancel side effect
          included.
        </p>
        <table className="diag" style={{ maxWidth: 420 }}>
          <tbody>
            <tr><td>Median</td><td className="mono">{fmtMs(handlerLatency.medianMs)}</td></tr>
            <tr><td>p95</td><td className="mono">{fmtMs(handlerLatency.p95Ms)}</td></tr>
            <tr><td>Worst case</td><td className="mono">{fmtMs(handlerLatency.maxMs)}</td></tr>
            <tr><td>Samples</td><td className="mono">{handlerLatency.count}</td></tr>
          </tbody>
        </table>
      </div>

      {/* B11: the other half of the hook budget, and the half B1 could never
          see. The row above times our handler once it is CALLED; this one times
          how late the call itself is. Windows measures both against the same
          ceiling, so a green handler on a blocked loop is a hook being removed
          while every number on this page looks healthy. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <span className="lbl">Event-loop lag (plan §3.6.6, trigger T1)</span>
        <p className="sub" style={{ margin: "6px 0 10px" }}>
          How late a timer actually runs, which is how long a key event waits in the queue before Flow can
          judge it at all. Sampled every {LOOP_LAG_ACTIVE_PERIOD_MS} ms while Flow is working and every{" "}
          {LOOP_LAG_IDLE_PERIOD_MS} ms while it is idle, so a percentile here is over observations, not over
          wall-clock time. A p99 above {LOOP_LAG_P99_THRESHOLD_MS} ms is the threshold that reopens the
          native-helper question. Read every row against the floor: on Windows the system timer runs on a
          15.625 ms grid, which alone puts about 11 ms under every sample.
        </p>
        <table className="diag" style={{ maxWidth: 420 }}>
          <tbody>
            <tr><td>Timer floor (smallest seen)</td><td className="mono">{fmtMs(snap.loopLag.minMs)}</td></tr>
            <tr><td>p50</td><td className="mono">{fmtMs(snap.loopLag.p50Ms)}</td></tr>
            <tr><td>p95</td><td className="mono">{fmtMs(snap.loopLag.p95Ms)}</td></tr>
            <tr>
              <td>p99</td>
              <td className="mono" style={snap.loopLag.overThreshold ? { color: "var(--err)", fontWeight: 600 } : undefined}>
                {fmtMs(snap.loopLag.p99Ms)}
                {snap.loopLag.overThreshold ? ` (over ${LOOP_LAG_P99_THRESHOLD_MS} ms)` : ""}
              </td>
            </tr>
            <tr><td>Worst case</td><td className="mono">{fmtMs(snap.loopLag.maxMs)}</td></tr>
            <tr><td>Samples</td><td className="mono">{snap.loopLag.count}</td></tr>
          </tbody>
        </table>
      </div>

      {/* B6: the named counters for every best-effort catch on the hot path.
          They ride this same snapshot (see hotpath.ts's silentFailureCounts) so
          they sit beside the measurements they explain: a press whose numbers
          look fine but whose cue never played has its reason in this table.
          Every known name is shown, including at zero - a row that appears only
          once something has broken is a row nobody knows to look for. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <span className="lbl">Tolerated failures (counted since launch)</span>
        <p className="sub" style={{ margin: "6px 0 10px" }}>
          Things Flow recovers from without stopping. All zeros is the normal state; a number here is
          the difference between &quot;it feels capricious&quot; and a named cause.
        </p>
        <table className="diag" style={{ maxWidth: 520 }}>
          <tbody>
            {Object.entries(snap.silentFailureCounts).map(([name, count]) => (
              <tr key={name}>
                <td className="mono">{name}</td>
                <td className="mono" style={count > 0 ? { color: "var(--err)", fontWeight: 600 } : undefined}>
                  {count}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* B4: press-less hot-path events. They belong beside the presses and not
          inside them: a hook death is precisely the reason a press is MISSING,
          so a table of presses alone would show an unexplained quiet stretch. */}
      {snap.events.length > 0 ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <span className="lbl">Keyboard hook incidents</span>
          <table className="diag" style={{ maxWidth: 420, marginTop: 8 }}>
            <tbody>
              {[...snap.events].reverse().map((e, i) => (
                <tr key={`${e.kind}-${e.t}-${i}`}>
                  <td className="mono">{agoLabel(e.t, snap.generatedAt)}</td>
                  <td>{hookEventLabel(e.kind)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card">
        <span className="lbl">Recent presses</span>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table className="diag" style={{ maxWidth: "none" }}>
            <thead>
              <tr>
                <td>When</td><td>Outcome</td><td>Verdict</td><td>Press&rarr;overlay</td>
                <td>Model</td><td>Release&rarr;text (excl. model)</td><td>Chars</td>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr><td colSpan={7} className="sub">No presses recorded yet - hold the dictation shortcut to generate traces.</td></tr>
              ) : (
                recent.slice(0, 50).map((tr) => {
                  const iv = computeIntervals(tr);
                  return (
                    <tr key={tr.id}>
                      <td className="mono">{agoLabel(traceLastT(tr), snap.generatedAt)}</td>
                      <td>{outcomeLabel(tr)}</td>
                      <td className="mono">{fmtMs(iv.verdictLatencyMs)}</td>
                      <td>
                        <BudgetCell value={iv.keyToOverlayOrderMs} budgetMs={30} measurable />
                      </td>
                      <td className="mono">{fmtMs(iv.transcriptionMs)}</td>
                      <td>
                        <BudgetCell value={iv.releaseToTextExclModelMs} budgetMs={60} measurable />
                      </td>
                      <td className="mono">{tr.textChars ?? "-"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
