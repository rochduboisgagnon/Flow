// Fetches the whisper-server binaries (whisper.cpp, prebuilt by the OpenWhispr
// whisper.cpp fork releases) into resources/bin/. v5: we ship TWO Windows builds
// and pick at runtime (sidecar.ts): the Vulkan build (GPU-accelerated on ANY
// modern GPU - NVIDIA, AMD, Intel - sub-second, e.g. Roch's RTX 4080) and the CPU
// build as the universal fallback. Vulkan is self-contained (vulkan-1.dll is a
// system file shipped with every GPU driver); no huge CUDA runtime to bundle.
// Pin a tag with WHISPER_CPP_VERSION for reproducible builds; WHISPER_FORCE re-fetches.
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const https = require("node:https");

const REPO = "OpenWhispr/whisper.cpp";
const OUT_DIR = path.join(__dirname, "..", "resources", "bin");
// The exe inside each zip is already variant-named; we keep those names so the
// runtime can choose. base = current cross-platform naming used by the sidecar.
const VARIANTS = ["cpu", "vulkan"];
const exeFor = (v) => path.join(OUT_DIR, `whisper-server-win32-x64-${v}.exe`);

if (process.platform !== "win32") {
  console.log("[fetch-whisper] windows only for now");
  process.exit(0);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "agr-flow", Accept: "application/vnd.github+json" } }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
          else resolve(JSON.parse(d));
        });
      })
      .on("error", reject);
  });
}

function downloadTo(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    https
      .get(url, { headers: { "User-Agent": "agr-flow" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(downloadTo(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

(async () => {
  const missing = VARIANTS.filter((v) => process.env.WHISPER_FORCE || !fs.existsSync(exeFor(v)));
  if (!missing.length) {
    console.log("[fetch-whisper] both builds already present:", OUT_DIR);
    process.exit(0);
  }
  const tagged = process.env.WHISPER_CPP_VERSION;
  const release = await getJson(
    tagged
      ? `https://api.github.com/repos/${REPO}/releases/tags/${tagged}`
      : `https://api.github.com/repos/${REPO}/releases/latest`,
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  for (const variant of missing) {
    const zip = `whisper-server-win32-x64-${variant}.zip`;
    const asset = (release.assets || []).find((a) => a.name === zip);
    if (!asset) throw new Error(`asset ${zip} not found in ${REPO} ${release.tag_name}`);
    const zipPath = path.join(OUT_DIR, zip);
    console.log(`[fetch-whisper] ${release.tag_name} / ${zip} (${(asset.size / 1048576).toFixed(1)} MB) ...`);
    await downloadTo(asset.browser_download_url, zipPath);
    // Windows 10+ ships bsdtar (System32), which reads zips. The ABSOLUTE path
    // matters: Git Bash puts GNU tar first, which reads neither zips nor "C:\".
    execSync(`"${sysTar}" -xf "${zip}"`, { stdio: "inherit", cwd: OUT_DIR });
    fs.unlinkSync(zipPath);
    // The extracted exe is already `whisper-server-win32-x64-<variant>.exe`.
    if (!fs.existsSync(exeFor(variant))) {
      const found = fs
        .readdirSync(OUT_DIR)
        .find((f) => f.startsWith("whisper-server") && f.includes(variant) && f.endsWith(".exe"));
      if (!found) throw new Error(`no ${variant} whisper-server exe after extraction`);
      if (path.join(OUT_DIR, found) !== exeFor(variant)) fs.renameSync(path.join(OUT_DIR, found), exeFor(variant));
    }
    console.log(`[fetch-whisper] ready: ${exeFor(variant)}`);
  }
  console.log(`[fetch-whisper] done (${release.tag_name}, variants: ${VARIANTS.join(", ")})`);
})().catch((e) => {
  console.error("[fetch-whisper] FAILED:", e.message);
  process.exit(1);
});
