import { contextBridge } from "electron";

// Thin, typed bridge. Grows with each commit (IPC contracts live in src/shared).
contextBridge.exposeInMainWorld("agrflow", {
  versions: {
    app: process.env.npm_package_version ?? "",
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
