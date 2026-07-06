// Fetches the whisper-server binary (whisper.cpp, prebuilt by the OpenWhispr
// project's whisper.cpp fork releases) into resources/bin/. CPU build by
// default - it runs everywhere; the CUDA build is an opt-in via
// WHISPER_VARIANT=cuda (bundles the CUDA runtime, much larger download).
// Pin a tag with WHISPER_CPP_VERSION for reproducible builds.
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const https = require("node:https");

const REPO = "OpenWhispr/whisper.cpp";
const VARIANT = process.env.WHISPER_VARIANT === "cuda" ? "cuda" : "cpu";
const ZIP = `whisper-server-win32-x64-${VARIANT}.zip`;
const OUT_DIR = path.join(__dirname, "..", "resources", "bin");
const OUT_EXE = path.join(OUT_DIR, "whisper-server-win32-x64.exe");

if (process.platform !== "win32") {
  console.log("[fetch-whisper] windows only for now");
  process.exit(0);
}
if (fs.existsSync(OUT_EXE) && !process.env.WHISPER_FORCE) {
  console.log("[fetch-whisper] already present:", OUT_EXE);
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
  const tagged = process.env.WHISPER_CPP_VERSION;
  const release = await getJson(
    tagged
      ? `https://api.github.com/repos/${REPO}/releases/tags/${tagged}`
      : `https://api.github.com/repos/${REPO}/releases/latest`,
  );
  const asset = (release.assets || []).find((a) => a.name === ZIP);
  if (!asset) throw new Error(`asset ${ZIP} not found in ${REPO} ${release.tag_name}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = path.join(OUT_DIR, ZIP);
  console.log(`[fetch-whisper] ${release.tag_name} / ${ZIP} ...`);
  await downloadTo(asset.browser_download_url, zipPath);
  // Windows 10+ ships bsdtar (System32), which understands zip archives: no
  // unzip dependency. The ABSOLUTE path matters: a Git Bash environment puts
  // GNU tar first in PATH, and GNU tar reads neither zips nor "C:\" paths.
  const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execSync(`"${sysTar}" -xf "${ZIP}"`, { stdio: "inherit", cwd: OUT_DIR });
  fs.unlinkSync(zipPath);
  const extracted = fs
    .readdirSync(OUT_DIR)
    .find((f) => f.startsWith("whisper-server") && f.endsWith(".exe"));
  if (!extracted) throw new Error("no whisper-server exe found after extraction");
  if (path.join(OUT_DIR, extracted) !== OUT_EXE) fs.renameSync(path.join(OUT_DIR, extracted), OUT_EXE);
  console.log("[fetch-whisper] ready:", OUT_EXE, `(${release.tag_name}, ${VARIANT})`);
})().catch((e) => {
  console.error("[fetch-whisper] FAILED:", e.message);
  process.exit(1);
});
