import React, { useEffect, useState } from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import {
  computeIntervals,
  evaluateBudgets,
  summarize,
  type HotpathSnapshot,
  type HotpathSummary,
  type HotpathTrace,
} from "../../../shared/hotpath";

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
      <HotpathPanel />
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
  // exactly what lets this function show the two "not measurable" rows even
  // when zero traces have been captured yet.
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
