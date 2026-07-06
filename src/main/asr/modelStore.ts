import fs from "node:fs";
import path from "node:path";
import https from "node:https";

// ASR models live in AGR Flow's OWN data folder (%LOCALAPPDATA%\AGR-Flow\models),
// outside the install directory: an app update must never re-download 190 MB,
// and an uninstall of the binaries can leave user data alone.
//
// Default model: ggml-small (multilingual, q5_1). French-first dictation rules
// out the English-only edge models for now (Moonshine/Parakeet are the planned
// phase-2 upgrade); small-q5_1 is the speed/accuracy sweet spot whisper.cpp
// ships quantized upstream.

export const DEFAULT_MODEL_FILE = "ggml-small-q5_1.bin";
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

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
