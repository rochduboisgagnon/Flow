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
  },
  server: { port: 5183, strictPort: true },
});
