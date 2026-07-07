// keyspy's own postinstall downloads its key-server archive but its extraction
// can fail silently under npm on Windows (observed: the .tar.gz sits in
// runtime/ with no WinKeyServer.exe next to it). Without that exe there is no
// push-to-talk at all, so we re-check and extract ourselves after install.
//
// Hard-won specifics (0.2.0 shipped WITHOUT the exe because of these):
// - `tar` by NAME can resolve to Git's MSYS tar when npm runs from a shell
//   whose PATH lists Git tools first; MSYS tar reads "C:\..." as a REMOTE host
//   ("Cannot connect to c:") and fails. Always call Windows' own bsdtar by
//   its absolute System32 path.
// - A missing exe must FAIL THE INSTALL (exit 1), never warn-and-continue:
//   the silent warning is exactly how a dead-PTT build reached the catalog.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "win32") process.exit(0);

const runtime = path.join(__dirname, "..", "node_modules", "keyspy", "runtime");
const exe = path.join(runtime, "WinKeyServer.exe");
const archive = path.join(runtime, "keyspy-win32-x64.tar.gz");

if (fs.existsSync(exe)) process.exit(0);
if (!fs.existsSync(archive)) {
  console.error("[ensure-keyspy] FATAL: keyspy's archive is missing (its postinstall failed entirely); no push-to-talk possible.");
  process.exit(1);
}
try {
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(fs.existsSync(tar) ? tar : "tar", ["-xzf", archive, "-C", runtime], { stdio: "inherit" });
} catch (err) {
  console.error("[ensure-keyspy] FATAL: extraction failed:", err.message);
  process.exit(1);
}
if (!fs.existsSync(exe)) {
  console.error("[ensure-keyspy] FATAL: WinKeyServer.exe still missing after extraction.");
  process.exit(1);
}
console.log("[ensure-keyspy] WinKeyServer.exe extracted");
