import fs from "node:fs";
import path from "node:path";
import https from "node:https";

// ASR models live in AGR Flow's OWN data folder (%LOCALAPPDATA%\AGR-Flow\models),
// outside the install directory: an app update must never re-download 190 MB,
// and an uninstall of the binaries can leave user data alone.
//
// Default model (plan v4 chantier 11, Roch's call = best French): large-v3-turbo
// (multilingual, q5_0). It is the strongest French transcriber whisper.cpp ships
// quantized, and the sidecar stays warm so the bigger model is a one-time load
// cost, not a per-utterance one. small-q5_1 stays in the list as the "fast"
// option for anyone who wants sub-second dictation over top accuracy.

export const DEFAULT_MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

// The models offered in the settings (all multilingual, all quantized builds
// shipped upstream by whisper.cpp). Accuracy/speed is the user's dial; turbo is
// the French-first default, small the fast fallback.
export const AVAILABLE_MODELS = [
  { file: "ggml-tiny-q5_1.bin", label: "Tiny - fastest, least accurate", size: "32 MB" },
  { file: "ggml-base-q5_1.bin", label: "Base - fast", size: "60 MB" },
  { file: "ggml-small-q5_1.bin", label: "Small - fast, good balance", size: "190 MB" },
  { file: "ggml-medium-q5_0.bin", label: "Medium - accurate, slower", size: "540 MB" },
  { file: "ggml-large-v3-turbo-q5_0.bin", label: "Large v3 Turbo - best French (default)", size: "547 MB" },
  { file: "ggml-large-v3-q5_0.bin", label: "Large v3 - most accurate, slowest", size: "1.1 GB" },
] as const;

export function modelsDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? ".", "AppData", "Local");
  return path.join(base, "AGR-Flow", "models");
}

export function modelPath(file = DEFAULT_MODEL_FILE): string {
  return path.join(modelsDir(), file);
}

/** Downloads the model on first run (atomic: .part then rename). */
export async function ensureModel(
  file = DEFAULT_MODEL_FILE,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const dest = modelPath(file);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  await download(HF_BASE + file, tmp, onProgress);
  fs.renameSync(tmp, dest);
  return dest;
}

function download(url: string, dest: string, onProgress?: (pct: number) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects downloading the model"));
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`model download failed: HTTP ${res.statusCode} for ${url}`));
        }
        const total = Number(res.headers["content-length"] ?? 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on("data", (c: Buffer) => {
          got += c.length;
          if (total && onProgress) onProgress(Math.round((got / total) * 100));
        });
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", (e) => {
          try {
            fs.unlinkSync(dest);
          } catch {
            /* best effort */
          }
          reject(e);
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}
