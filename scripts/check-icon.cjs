// The titlebar renders src/renderer/assets/icon.png (Vite emits it as a
// relative hashed asset so the packaged file:// load works); the tray and the
// installer use resources/icon.png. Plan A8 says the icon never changes -
// this gate fails the build the day the two copies diverge, instead of
// shipping a window whose brand differs from its own taskbar.
const fs = require("node:fs");
const path = require("node:path");

const canonical = path.join(__dirname, "..", "resources", "icon.png");
const rendererCopy = path.join(__dirname, "..", "src", "renderer", "assets", "icon.png");

// Review U1j: a missing file must fail with THIS script's guidance, not a raw
// ENOENT stack - a CI log reader should see the word "icon" and the fix, not
// ten lines of node:internal.
function read(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    console.error(`[check-icon] cannot read ${p}`);
    console.error("[check-icon] resources/icon.png is the canonical file (never modified, plan A8); src/renderer/assets/icon.png must be a byte-identical copy of it");
    process.exit(1);
  }
}
const a = read(canonical);
const b = read(rendererCopy);
if (!a.equals(b)) {
  console.error("[check-icon] src/renderer/assets/icon.png is NOT byte-identical to resources/icon.png");
  console.error("[check-icon] resources/icon.png is the canonical file (never modified, plan A8): re-copy it over the renderer asset");
  process.exit(1);
}
