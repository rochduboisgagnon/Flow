import React from "react";
import type { UiStatePayload } from "../../../shared/ipcContracts";

// Diagnostics (wave U1 restyle): same facts as before, mockup's card + table.
// Everything here is copyable (the user-select allowlist covers table.diag
// and .mono) - a diagnostic you cannot paste into a bug report is useless.
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
    </>
  );
}
