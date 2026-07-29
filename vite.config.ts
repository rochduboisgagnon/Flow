import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer only. The main process is compiled separately by tsc (tsconfig.main.json):
// keeping the two builds independent means no electron-specific vite plugin to maintain.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: "src/renderer/overlay.html",
        capture: "src/renderer/capture.html", // C2: hidden native-capture window
        decode: "src/renderer/decode.html", // V4 D1: hidden audio-decode window
        main: "src/renderer/main.html", // V1: the standalone main window
      },
    },
  },
  server: { port: 5183, strictPort: true },
});
