import React from "react";

// Shared UI atoms (wave U1). The markup mirrors design/mockup.html so the
// stylesheet port stays reviewable against the mockup: .row > .l/.c, the
// ::after-knob toggle, 24-grid stroke icons.

// ---- tiny stroke icons (charte: stroke only, no fills, no emoji) ----
export function Icon({ d, d2 }: { d: string; d2?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
      {d2 ? <path d={d2} /> : null}
    </svg>
  );
}
export const IC = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z",
  record: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z",
  record2: "M5 11v1a7 7 0 0 0 14 0v-1M12 19v3",
  import: "M12 3v12m0 0 4-4m-4 4-4-4M4 21h16",
  notes: "M6 2h9l5 5v15H6zM14 2v6h6",
  stats: "M4 21V10M10 21V4M16 21v-7M22 21H2",
  diag: "M2 12h4l3 8 4-16 3 8h6",
  dict: "M4 20V5a2 2 0 0 1 2-2h13v14H6a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h13",
  func: "M13 2 4 14h6l-1 8 9-12h-6z",
  snip: "M9 3v18M4 8h14a3 3 0 0 1 0 6H4",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  gear2: "M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.06-.4.1-.8.1-1.2z",
};

// ---- enable/disable switch (the knob is CSS ::after; state lives on .on) ----
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div
      className={"toggle" + (on ? " on" : "")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // Space must not scroll the settings page
          onChange(!on);
        }
      }}
    />
  );
}

// ---- settings row: label + help left, control right (mockup .row .l/.c) ----
export function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="l">
        <b>{label}</b>
        {help ? <span>{help}</span> : null}
      </div>
      <div className="c">{children}</div>
    </div>
  );
}

/** The honest not-yet state (plan rule: never a dead control that looks
 * alive). Real intro sentence, ONE line naming what is missing, and the wave
 * that builds it - no fake queues, no fabricated numbers, nothing clickable. */
export function Coming({ title, blurb, missing, wave }: { title: string; blurb: string; missing: string; wave: string }) {
  return (
    <>
      <h2>{title}</h2>
      <p className="sub">{blurb}</p>
      <div className="coming">
        <span className="soon">Planned</span>
        <div>{missing}</div>
        <div className="wave">{wave}</div>
      </div>
    </>
  );
}
