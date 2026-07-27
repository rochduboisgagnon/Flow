import React from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import { Ribbon } from "../Ribbon";
import type { Section } from "../Rail";

// Home (wave U1): the mockup's hero + status cards, REAL data only. The
// mockup's "Words today / This week" cards are deliberately absent - their
// numbers would be fabricated until the statistics wave decides (with Roch)
// whether counters are written at all. Typed flags drive the states (audit:
// the status STRING is display-only, cards never sniff it).
export function Home({ s, go }: { s: UiStatePayload; go: (sec: Section) => void }) {
  const hookDead = !s.hookOk;
  const engineErr = s.modelState.status === "error" || (!s.engineWarm && s.modelState.status !== "downloading");
  const last = s.recent[0];
  return (
    <>
      <h2>Home</h2>
      <p className="sub">Local, on-device voice transcription. Nothing ever leaves this machine.</p>
      <div className="home-grid">
        <div className="card hero-card">
          <div>
            <span className="lbl">Dictation</span>
            <div className="big">
              <span className={"dot " + (hookDead ? "err" : s.listening ? "on" : s.paused ? "off" : "on")} />
              {hookDead ? "Keyboard hook unavailable" : s.paused ? "Paused" : s.listening ? "Listening" : "Armed"}
            </div>
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Hold <span className="kbd">{s.comboLabel}</span> anywhere and speak. Double-tap for hands-free.
            </p>
          </div>
          <div className="ribbon-mini">
            <Ribbon />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn amber" onClick={() => go("record")}>Start a recording</button>
            <button className="btn ghost" onClick={() => go("import")}>Import audio</button>
          </div>
        </div>
        <div className="card">
          <span className="lbl">Speech engine</span>
          <div className="stat-inline" style={{ marginTop: 8 }}>
            <span className={"dot " + (engineErr ? "err" : s.engineWarm ? "on" : "off")} />
            <b style={{ fontSize: 14 }}>{s.status}</b>
          </div>
          <p className="sub" style={{ margin: "5px 0 0" }}>
            {(s.backend ? `Backend: ${s.backend}` : "Backend: selecting...") +
              " - model " + s.settings.model.replace("ggml-", "").replace(".bin", "")}
          </p>
          {s.modelState.status === "downloading" ? (
            <div className="progress"><div style={{ width: `${s.modelState.pct ?? 0}%` }} /></div>
          ) : null}
        </div>
        <div className="card">
          {/* Review U1j: s.recording stays visible WHATEVER recent[] holds -
              this card is the only surface in the app that reports a live
              long recording, and `recent` only ever lists FINISHED captures. */}
          <span className="lbl">Long recording</span>
          <div className="stat-inline" style={{ marginTop: 8 }}>
            <span className={"dot " + (s.recording ? "on" : "off")} />
            <b style={{ fontSize: 14 }}>{s.recording ? "Recording in progress" : "Idle"}</b>
          </div>
          <p className="sub" style={{ margin: "5px 0 0" }}>
            {last
              ? `Last capture: ${last.title} - ${new Date(last.startedIso).toLocaleString()} (${Math.round(last.durationMs / 60000)} min)`
              : "No capture yet."}
          </p>
        </div>
      </div>
    </>
  );
}
