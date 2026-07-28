import React from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";
import { Ribbon } from "../Ribbon";
import type { Section } from "../Rail";

// Home (wave U1): the mockup's hero + status cards, REAL data only. The
// mockup's "Words today / This week" cards are deliberately absent - their
// numbers would be fabricated until the statistics wave decides (with Roch)
// whether counters are written at all. Typed flags drive the states (audit:
// the status STRING is display-only, cards never sniff it).
// B4: the hook has more than two states now, and the difference matters to the
// person reading the card. "Restarting" is a one-second blip Flow is already
// fixing (do nothing, it is coming back); "unavailable" is terminal and needs a
// restart of the app. Collapsing them into one red line would tell someone to
// restart Flow while Flow was in the middle of fixing itself.
function dictationLabel(s: UiStatePayload): string {
  switch (s.hook.state) {
    case "restarting":
      return "Restarting the keyboard shortcut...";
    case "abandoned":
      return "Keyboard shortcut unavailable";
    case "starting":
      return "Arming the keyboard shortcut...";
    default:
      return s.paused ? "Paused" : s.listening ? "Listening" : "Armed";
  }
}

export function Home({ s, go }: { s: UiStatePayload; go: (sec: Section) => void }) {
  const hookDead = !s.hookOk;
  const engineErr = s.modelState.status === "error" || (!s.engineWarm && s.modelState.status !== "downloading");
  const last = s.recent[0];
  // B4: an incident that HEALED still has to leave a mark. Recovery restores
  // "Armed" within a second or two, and without this line the user would have
  // no way to connect "my shortcut did nothing just then" to anything real -
  // which is the exact experience this task exists to end.
  const healed = s.hookOk && s.hook.deaths > 0;
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
              {dictationLabel(s)}
            </div>
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Hold <span className="kbd">{s.comboLabel}</span> anywhere and speak. Double-tap for hands-free.
            </p>
            {healed ? (
              <p className="sub" style={{ margin: "6px 0 0" }}>
                Flow recovered the keyboard shortcut {s.hook.restarts === 1 ? "once" : `${s.hook.restarts} times`} this
                session ({s.hook.deaths} interruption{s.hook.deaths === 1 ? "" : "s"}). Anything you said during one of
                them was not captured. See Diagnostics.
              </p>
            ) : null}
            {s.hook.state === "abandoned" ? (
              <p className="note-err" style={{ margin: "6px 0 0" }}>
                The keyboard shortcut kept failing, so Flow stopped restarting it. Restart Flow to get dictation back.
              </p>
            ) : null}
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
