import React from "react";
import type { UiStatePayload } from "../../shared/ipcContracts";
import iconUrl from "../assets/icon.png";

// Frameless titlebar (wave U1). The native min/max/close buttons are drawn by
// Windows (titleBarOverlay) over the top-right corner; the CSS pads our
// content out from under them via env(titlebar-area-width). The whole bar is
// a drag region; nothing in it is interactive today, so no no-drag exceptions
// exist yet - the first interactive child MUST get -webkit-app-region:no-drag
// or it becomes unclickable. No dblclick handler either: Electron already maps
// double-click on a drag region to maximize/restore.
export function Titlebar({ s }: { s: UiStatePayload | null }) {
  // Review U1j: the dot mirrors the ENGINE status text it sits next to - the
  // SAME predicate as Home's engine card, so the two indicators can never
  // contradict each other. Keyboard-hook health is a dictation concern and
  // belongs to Home's dictation card (and the status TEXT already says
  // "keyboard hook unavailable" when it happens).
  const engineErr = s !== null && (s.modelState.status === "error" || (!s.engineWarm && s.modelState.status !== "downloading"));
  return (
    <div className="titlebar">
      <div className="tb-brand">
        {/* Byte-identical copy of resources/icon.png (enforced at build). */}
        <img className="tb-icon" src={iconUrl} alt="" width={20} height={20} />
        <span className="tb-name">Flow</span>
      </div>
      <div className="tb-drag" />
      <div className="tb-status">
        <span className={"dot " + (engineErr ? "err" : s?.engineWarm ? "on" : "off")} />
        {s === null ? "Starting" : s.status}
      </div>
    </div>
  );
}
