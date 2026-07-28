// Activation hot-path report: `npm run bench:hotpath` (or `npx tsx scripts/bench-hotpath.ts`).
//
// WHY THIS READS A RUNNING APP, NOT A FILE (plan V2, B1):
// unlike scripts/bench-latency.ts (which benchmarks the ASR sidecar directly -
// a headless HTTP module with no dependency on a real keyboard or a real
// window), the activation hot path is fundamentally about REAL keyboard
// events, a REAL overlay window round-trip and a REAL focus probe. There is
// no way to "run the hot path standalone": it only exists inside a live Flow
// process. So this script queries that process's own loopback API instead of
// re-implementing anything - the SAME zero-retention ring the Diagnostics
// panel polls over IPC (src/shared/hotpath.ts), reached here over the local
// HTTP surface (main/api.ts's GET /diagnostics/hotpath) via the SAME
// discovery file (~/.flow/api.json) every sibling app already uses.
//
// HOW TO FEED IT: start Flow (`npm run dev`, or the installed app), press and
// hold the dictation shortcut a few times (speak for a real completed trace;
// silence still produces a real "gated-no-speech" abandoned trace, which is
// enough to see the hook/overlay/WAV-round-trip numbers), then run this
// script. It prints "Flow is not reachable" with the same instructions if the
// engine is not up.
import http from "node:http";
import { apiInfoPath } from "../src/main/api";
import {
  computeIntervals,
  evaluateBudgets,
  summarize,
  type HotpathSnapshot,
  type HotpathSummary,
  type HotpathTrace,
} from "../src/shared/hotpath";
import fs from "node:fs";

const HELP =
  "Flow does not appear to be running (or its local API is not reachable yet).\n" +
  "Start it - `npm run dev`, or the installed app - then press and hold the\n" +
  "dictation shortcut a few times (speaking is not required: even silence\n" +
  "produces a real abandoned trace with hook/overlay/WAV timings), and run\n" +
  "`npm run bench:hotpath` again.";

function readApiInfo(): { port: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(apiInfoPath(), "utf8")) as { port?: number; app?: string };
    if (typeof raw.port !== "number") return null;
    return { port: raw.port };
  } catch {
    return null;
  }
}

function getJson<T>(port: number, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path, timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${path} -> HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`GET ${path} timed out`));
    });
    req.on("error", reject);
  });
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

function fmtMs(ms: number | null): string {
  return ms === null ? "-" : ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
}

function summaryRow(label: string, budgetMs: number | null, measurable: boolean, s: HotpathSummary): string[] {
  if (!measurable) return [label, budgetMs !== null ? String(budgetMs) : "-", "n/a", "n/a", "n/a", "0"];
  const over = (v: number | null) => (v !== null && budgetMs !== null && v >= budgetMs ? "*" : "");
  return [
    label,
    budgetMs !== null ? String(budgetMs) : "-",
    fmtMs(s.medianMs) + over(s.medianMs),
    fmtMs(s.p95Ms) + over(s.p95Ms),
    fmtMs(s.maxMs) + over(s.maxMs),
    String(s.count),
  ];
}

function report(snapshot: HotpathSnapshot): void {
  const { completed, open, handlerLatenciesMs } = snapshot;
  console.log(`\nFlow activation hot path - ${completed.length} completed traces, ${open.length} in flight\n`);

  if (completed.length === 0) {
    console.log(
      "No completed traces yet. Press and hold the dictation shortcut a few times, wait for the\n" +
        "overlay to disappear each time, then run this again.\n",
    );
  }

  // ---- §3.3 budgets, aggregated across every completed trace ----
  const placeholder = evaluateBudgets({ id: 0, outcome: "abandoned", marks: [] });
  const perMetric: number[][] = placeholder.map(() => []);
  for (const tr of completed) {
    evaluateBudgets(tr).forEach((row, i) => {
      if (row.valueMs !== null) perMetric[i].push(row.valueMs);
    });
  }
  console.log("Budgets (plan §3.3) - * marks median/p95/worst-case at or over budget\n");
  printTable(
    ["metric", "budget(ms)", "median(ms)", "p95(ms)", "worst(ms)", "n"],
    placeholder.map((row, i) => summaryRow(row.metric, row.budgetMs, row.measurable, summarize(perMetric[i]))),
  );

  // ---- menace §3.2.2: the hook handler's own cost, every keyboard event ----
  const handlerSummary = summarize(handlerLatenciesMs);
  console.log("\nKeyboard hook handler latency (every key event through the hook, not just the shortcut)\n");
  printTable(
    ["median(ms)", "p95(ms)", "worst(ms)", "n"],
    [[fmtMs(handlerSummary.medianMs), fmtMs(handlerSummary.p95Ms), fmtMs(handlerSummary.maxMs), String(handlerSummary.count)]],
  );

  // ---- outcome / abandon-reason breakdown ----
  const byOutcome = new Map<string, number>();
  for (const tr of completed) {
    const key = tr.outcome === "completed" ? `completed (${tr.result})` : `abandoned (${tr.reason ?? "unknown"})`;
    byOutcome.set(key, (byOutcome.get(key) ?? 0) + 1);
  }
  if (byOutcome.size) {
    console.log("\nOutcomes\n");
    printTable(
      ["outcome", "count"],
      [...byOutcome.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]),
    );
  }

  // ---- per-trace detail, most recent last (chronological, easy to scroll to the bottom) ----
  if (completed.length) {
    console.log("\nPer-press detail (chronological)\n");
    const rows: string[][] = completed.map((tr: HotpathTrace, i) => {
      const iv = computeIntervals(tr);
      return [
        String(i + 1),
        tr.outcome === "completed" ? (tr.result ?? "completed") : `abandoned:${tr.reason ?? "?"}`,
        fmtMs(iv.verdictLatencyMs),
        fmtMs(iv.keyToOverlayOrderMs),
        // B2: the two the overlay renderer reports. `mic` is the number to
        // watch across a session - the FIRST press pays the microphone
        // acquisition, every press inside the pre-warm window answers 0.00
        // because the pre-roll already held the audio from before the key.
        fmtMs(iv.pressToFirstPaintMs),
        fmtMs(iv.pressToFirstSampleMs),
        fmtMs(iv.transcriptionMs),
        fmtMs(iv.releaseToTextExclModelMs),
        String(tr.textChars ?? "-"),
      ];
    });
    printTable(
      [
        "#", "outcome", "verdict(ms)", "press>overlay(ms)", "press>paint(ms)", "press>mic(ms)",
        "model(ms)", "release>text excl.model(ms)", "chars",
      ],
      rows,
    );
  }

  console.log(
    "\nAll four §3.3 budgets are measurable since B2. The two that happen inside the\n" +
      "overlay renderer (press -> first frame painted, press -> microphone capturing)\n" +
      "are reported by that process as durations on its own clock and folded into the\n" +
      "trace by adding them to an instant the main process recorded itself, so no two\n" +
      "clocks are ever compared. The one-way IPC hop is therefore not counted: both\n" +
      "are LOWER bounds. A dash means the press never produced them (a refusal, or a\n" +
      "capture that failed before the microphone was live).\n",
  );
}

async function main() {
  const info = readApiInfo();
  if (!info) {
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  try {
    await getJson(info.port, "/status"); // confirms Flow, not just some other process on that port
    const snapshot = await getJson<HotpathSnapshot>(info.port, "/diagnostics/hotpath");
    report(snapshot);
  } catch (e) {
    console.error(HELP);
    console.error(`\n(detail: ${e instanceof Error ? e.message : String(e)})`);
    process.exitCode = 1;
  }
}

void main();
