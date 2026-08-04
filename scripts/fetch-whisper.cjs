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
// 2026-08-04, PORTAGE macOS : les assets a prendre viennent du MANIFESTE
// (native-deps.json), filtres par plateforme, et non d'une liste ecrite ici.
//
// C'est le point : le manifeste est ce qui porte les EMPREINTES. Deriver les noms
// d'ailleurs rendrait possible de telecharger un asset non epingle, ce qui est
// precisement le trou que le scan de securite du 2026-08-02 a ferme. Ici, un asset
// qui n'est pas dans le manifeste n'est pas telechargeable du tout.
//
// macOS : UN seul binaire (Metal fait partie du systeme, donc rien a choisir).
// Windows : deux constructions, Vulkan puis CPU, choisies a l'execution.
const PLATFORM_TAG = process.platform === "darwin" ? "darwin" : "win32";

/** Les assets epingles pour CETTE plateforme, et le fichier attendu apres
 * extraction (le nom de l'archive, sans son extension). */
function assetsForPlatform(pinnedAssets) {
  return Object.keys(pinnedAssets)
    .filter((name) => name.includes(PLATFORM_TAG))
    .map((asset) => ({
      asset,
      // whisper-server-darwin-arm64.zip -> whisper-server-darwin-arm64
      // whisper-server-win32-x64-cpu.zip -> whisper-server-win32-x64-cpu.exe
      binary: process.platform === "darwin" ? asset.replace(/\.zip$/, "") : asset.replace(/\.zip$/, ".exe"),
    }));
}

// CI, 2026-07-27: the v1.3.0 release job died here on "API rate limit
// exceeded" - GitHub allows only 60 anonymous REST calls per hour PER IP, and
// hosted runners share their IPs with the rest of the world. Same class of
// failure as the keyspy fetch, fixed the same way: send the token when the
// environment has one. Locally there is usually none, and 60 calls/hour is
// plenty for a developer; on CI the workflow passes GITHUB_TOKEN and the
// budget becomes 1000/hour for the repository. The token is only ever sent to
// api.github.com, never followed into the redirect that serves the asset.
function ghHeaders(extra) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return Object.assign({ "User-Agent": "flow" }, extra, token ? { Authorization: `Bearer ${token}` } : {});
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: ghHeaders({ Accept: "application/vnd.github+json" }) }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode === 403 && /rate limit/i.test(d)) {
            reject(new Error("GitHub API rate limit reached. Set GH_TOKEN (CI passes secrets.GITHUB_TOKEN) or retry later."));
          } else if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
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
      .get(url, { headers: { "User-Agent": "flow" } }, (res) => {
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
  // Le manifeste d'abord : il decide QUELS assets existent, et c'est lui qui porte
  // les empreintes. Lu avant tout appel reseau.
  const pinnedAll = JSON.parse(fs.readFileSync(path.join(__dirname, "native-deps.json"), "utf8"));
  const wanted = assetsForPlatform(pinnedAll.whisper.assets);
  if (!wanted.length) {
    console.error(`[fetch-whisper] aucun asset epingle pour ${PLATFORM_TAG} dans native-deps.json`);
    process.exit(1);
  }
  const missing = wanted.filter((w) => process.env.WHISPER_FORCE || !fs.existsSync(path.join(OUT_DIR, w.binary)));
  if (!missing.length) {
    console.log(`[fetch-whisper] already present (${PLATFORM_TAG}):`, OUT_DIR);
    process.exit(0);
  }
  // 2026-08-02, security scan (HIGH): this used to fall through to /releases/latest
  // when WHISPER_CPP_VERSION was unset - which is what CI did. The release job
  // therefore packaged whatever a third-party fork had published most recently,
  // unverified, and the provenance attestation signed the result as genuine.
  // The pinned version now comes from the committed manifest, and the env var is
  // an override for local experiments only.
  const pinned = pinnedAll;
  const tagged = process.env.WHISPER_CPP_VERSION || pinned.whisper.version;
  const release = await getJson(
    tagged
      ? `https://api.github.com/repos/${REPO}/releases/tags/${tagged}`
      : `https://api.github.com/repos/${REPO}/releases/latest`,
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Windows 10+ livre bsdtar dans System32, qui lit les zips. Le chemin ABSOLU
  // compte : Git Bash met le tar GNU en premier, et lui ne lit ni les zips ni
  // « C:\ ». Sur macOS, le tar du systeme lit les zips aussi, et il est dans le
  // PATH sans piege.
  const sysTar =
    process.platform === "darwin"
      ? "tar"
      : path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  for (const want of missing) {
    const zip = want.asset;
    const asset = (release.assets || []).find((a) => a.name === zip);
    if (!asset) throw new Error(`asset ${zip} not found in ${REPO} ${release.tag_name}`);
    const zipPath = path.join(OUT_DIR, zip);
    console.log(`[fetch-whisper] ${release.tag_name} / ${zip} (${(asset.size / 1048576).toFixed(1)} MB) ...`);
    await downloadTo(asset.browser_download_url, zipPath);
    // BEFORE extraction, never after: an archive that fails this check must not
    // have had the chance to write a single file into resources/bin.
    execSync(`node "${path.join(__dirname, "verify-native-deps.cjs")}" whisper "${zipPath}"`, {
      stdio: "inherit",
    });
    // Windows 10+ ships bsdtar (System32), which reads zips. The ABSOLUTE path
    // matters: Git Bash puts GNU tar first, which reads neither zips nor "C:\".
    execSync(`"${sysTar}" -xf "${zip}"`, { stdio: "inherit", cwd: OUT_DIR });
    fs.unlinkSync(zipPath);
    const out = path.join(OUT_DIR, want.binary);
    if (!fs.existsSync(out)) {
      const found = fs.readdirSync(OUT_DIR).find((f) => f.startsWith("whisper-server") && f.includes(PLATFORM_TAG));
      if (!found) throw new Error(`no whisper-server binary after extracting ${zip}`);
      if (path.join(OUT_DIR, found) !== out) fs.renameSync(path.join(OUT_DIR, found), out);
    }
    // Un zip ne porte pas toujours le bit d'execution, et un binaire non
    // executable echoue au `spawn` avec EACCES - une panne qui ressemble a un
    // fichier manquant. Sans effet sur Windows.
    if (process.platform === "darwin") fs.chmodSync(out, 0o755);
    console.log(`[fetch-whisper] ready: ${out}`);
  }
  console.log(`[fetch-whisper] done (${release.tag_name}, ${PLATFORM_TAG})`);
})().catch((e) => {
  console.error("[fetch-whisper] FAILED:", e.message);
  process.exit(1);
});
