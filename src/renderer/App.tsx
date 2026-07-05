import React from "react";

// Settings shell. Fills up over the next commits (keybind, microphone, model).
export function App() {
  return (
    <div
      style={{
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        background: "#0b0d10",
        color: "#e9edf2",
        minHeight: "100vh",
        margin: 0,
        padding: "28px 32px",
        boxSizing: "border-box",
      }}
    >
      <h1 style={{ fontSize: 20, margin: 0 }}>AGR Flow</h1>
      <p style={{ color: "#8b93a0", fontSize: 13, marginTop: 6 }}>
        Local dictation. Hold the shortcut, speak, release: the text lands at your
        cursor. Nothing leaves this machine; nothing is stored.
      </p>
      <p style={{ color: "#5c6470", fontSize: 12, marginTop: 24 }}>
        Settings arrive with the next commits (shortcut, microphone, model).
      </p>
    </div>
  );
}
