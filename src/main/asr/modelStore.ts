import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { defaultLocalAppData, resolveModelsRoot } from "../migrate";

// ASR models live in Flow's OWN data folder (%LOCALAPPDATA%\Flow\models),
// outside the install directory: an app update must never re-download 190 MB,
// and an uninstall of the binaries can leave user data alone.
//
// THE DICTATION MODEL, pinned since 2026-07-30. Not a default any more: the
// dictation model is no longer a setting at all (see main/settings.ts).
//
// Why it was pinned. Dictating on large-v3 measured 16 547 ms per utterance on
// a real machine - the app was unusable for the one thing it exists to do. The
// instruction that followed was "the same for everyone, no option, the best one
// for ALL languages, not just French".
//
// Why THIS one answers that. large-v3-turbo is not a French model, and the old
// label saying so was wrong. It is the multilingual model distilled from
// large-v3: the same 99 languages, roughly 8x faster, for a small accuracy
// loss. For DICTATION, "best" cannot mean "most accurate in the absolute" - a
// transcription that lands 16 seconds after you let go of the key has already
// failed, however exact it is. It means the most accurate among those that
// return the text immediately.
//
// The accuracy of large-v3 is not lost: it moved to `batchModel`, where a
// meeting or an import runs and nobody is waiting.

export const DEFAULT_MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

// The models offered for BATCH work (meetings, imports) - all multilingual, all
// quantized builds shipped upstream by whisper.cpp. Dictation no longer appears
// here: it is pinned above. Accuracy/speed is a dial only where waiting is free.
export const AVAILABLE_MODELS = [
  { file: "ggml-tiny-q5_1.bin", label: "Tiny - fastest, least accurate", size: "32 MB" },
  { file: "ggml-base-q5_1.bin", label: "Base - fast", size: "60 MB" },
  { file: "ggml-small-q5_1.bin", label: "Small - fast, good balance", size: "190 MB" },
  { file: "ggml-medium-q5_0.bin", label: "Medium - accurate, slower", size: "540 MB" },
  { file: "ggml-large-v3-turbo-q5_0.bin", label: "Large v3 Turbo - multilingual, fast", size: "547 MB" },
  { file: "ggml-large-v3-q5_0.bin", label: "Large v3 - most accurate, slowest", size: "1.1 GB" },
] as const;

// A5: %LOCALAPPDATA%\Flow since 1.0.0, still %LOCALAPPDATA%\AGR-Flow on a
// machine whose migration has not landed yet. Resolved ONCE per process, like
// dataDir(): if this answer changed mid-run, ensureModel() would re-download
// 1.6 GB of models that are already sitting on the disk under the other name.
let cachedModelsRoot: string | null = null;

export function modelsDir(): string {
  if (cachedModelsRoot === null) cachedModelsRoot = resolveModelsRoot(defaultLocalAppData());
  return path.join(cachedModelsRoot, "models");
}

export function modelPath(file = DEFAULT_MODEL_FILE): string {
  return path.join(modelsDir(), file);
}

// R1: the smallest real model (tiny-q5_1) is ~32 MB. Anything under this floor is
// a truncated download or an HTML error/blocking page, never a usable model. A
// grossly-short .bin that slips through would make whisper-server fail to load and
// the user would see "the animation plays but nothing writes".
const MIN_MODEL_BYTES = 20 * 1024 * 1024;

/** Downloads the model on first run (atomic: .part then rename). R1: a partial or
 * blocked download is NEVER kept - the size is validated against Content-Length
 * before the rename, and an existing but grossly-truncated .bin is re-fetched. */
export async function ensureModel(
  file = DEFAULT_MODEL_FILE,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const dest = modelPath(file);
  if (fs.existsSync(dest)) {
    // R1: an earlier run may have left a truncated .bin (download cut, HTML stub).
    // existsSync used to short-circuit it FOREVER; validate a plausible size first.
    try {
      if (fs.statSync(dest).size >= MIN_MODEL_BYTES) return dest;
    } catch {
      return dest; // stat failed but the file is there: leave it, don't loop
    }
    try {
      fs.unlinkSync(dest);
    } catch {
      /* fall through: the download below will overwrite the .part and rename */
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  await download(HF_BASE + file, tmp, onProgress);
  // R1: refuse a suspiciously small result even if the server sent no Content-Length.
  let size = 0;
  try {
    size = fs.statSync(tmp).size;
  } catch {
    /* handled below */
  }
  if (size < MIN_MODEL_BYTES) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new Error(`model download too small (${size} bytes): not a usable model, refusing to keep it`);
  }
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
        out.on("finish", () =>
          out.close(() => {
            // R1: a cut connection can end the stream cleanly with a short file. If the
            // server told us the length, insist on getting all of it before we accept it.
            if (total > 0 && got !== total) {
              try {
                fs.unlinkSync(dest);
              } catch {
                /* best effort */
              }
              return reject(new Error(`model download truncated: got ${got} of ${total} bytes`));
            }
            resolve();
          }),
        );
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
