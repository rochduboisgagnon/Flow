import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./main.css";

// Pre-paint theme (wave U1): the first paint happens before getState()
// resolves, so the theme class must be set SYNCHRONOUSLY from the value the
// main process injected at window creation (flowui.initialTheme, from
// --flow-theme in process.argv). Without this, every light-theme user gets
// one dark frame on every open. Live changes ride the state push (App).
document.documentElement.classList.toggle("light", window.flowui.initialTheme === "light");

createRoot(document.getElementById("root")!).render(<App />);
