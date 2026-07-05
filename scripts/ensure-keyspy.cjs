// keyspy's own postinstall downloads its key-server archive but its extraction
// can fail silently under npm on Windows (observed: the .tar.gz sits in
// runtime/ with no WinKeyServer.exe next to it). Without that exe there is no
// push-to-talk at all, so we re-check and extract ourselves after install.
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "win32") process.exit(0);

const runtime = path.join(__dirname, "..", "node_modules", "keyspy", "runtime");
const exe = path.join(runtime, "WinKeyServer.exe");
const archive = path.join(runtime, "keyspy-win32-x64.tar.gz");

if (fs.existsSync(exe)) process.exit(0);
if (!fs.existsSync(archive)) {
  console.warn("[ensure-keyspy] archive missing; keyspy postinstall may have failed entirely");
  process.exit(0); // npm install itself should not hard-fail; the app surfaces the error at runtime
}
try {
  execSync(`tar -xzf "${archive}" -C "${runtime}"`, { stdio: "inherit" });
  console.log("[ensure-keyspy] WinKeyServer.exe extracted");
} catch (err) {
  console.warn("[ensure-keyspy] extraction failed:", err.message);
}
