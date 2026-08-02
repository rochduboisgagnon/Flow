import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
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

// ---------------------------------------------------------------------------
// Security scan F8 (MEDIUM, 2026-08-02). What decides the bytes this app feeds
// to a native C++ parser.
//
// This used to be `.../resolve/main/`: a BRANCH, which is a moving name, and the
// only check on the result was "at least 20 MB". Whoever controlled the upstream
// account, its branch, or any redirect hop chose the exact bytes every install
// of Flow would hand to the GGML loader - a silent model swap that changes what
// gets typed at your cursor at the mild end, an exploitable memory bug in native
// code at the other. The two native binaries beside this file had committed
// hashes; the largest untrusted blob in the app had a size floor.
//
// Pinned to an immutable commit, with a SHA-256 per file, verified before the
// downloaded file is put in place.
//
// PROVENANCE, because a hash nobody can re-derive is a decoration: taken from
// HuggingFace's own tree API at this revision (the LFS oid IS the content
// SHA-256), then checked against the two models already on the author's disk -
// both matched byte for byte. Re-derive with:
//   curl -s "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/<REV>"
// ---------------------------------------------------------------------------
const HF_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
const HF_BASE = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_REVISION}/`;

/** SHA-256 of every model this app will download, at HF_REVISION. A file absent
 * from this table CANNOT be fetched - the same rule as native-deps.json, and for
 * the same reason: an unlisted asset must be a failure, never a pass, or the
 * check silently stops applying the day someone adds a seventh model. */
export const MODEL_SHA256: Readonly<Record<string, string>> = {
  "ggml-tiny-q5_1.bin": "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
  "ggml-base-q5_1.bin": "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  "ggml-small-q5_1.bin": "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  "ggml-medium-q5_0.bin": "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
  "ggml-large-v3-turbo-q5_0.bin": "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  "ggml-large-v3-q5_0.bin": "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
};

/** Exact byte size at HF_REVISION. Not a security control on its own - a size is
 * trivial to match - but it is the check that is FREE, so it is the one that can
 * run against an already-installed model at every launch. See ensureModel. */
export const MODEL_BYTES: Readonly<Record<string, number>> = {
  "ggml-tiny-q5_1.bin": 32_152_673,
  "ggml-base-q5_1.bin": 59_707_625,
  "ggml-small-q5_1.bin": 190_085_487,
  "ggml-medium-q5_0.bin": 539_212_467,
  "ggml-large-v3-turbo-q5_0.bin": 574_041_195,
  "ggml-large-v3-q5_0.bin": 1_081_140_203,
};

/**
 * P9 : le modele de REDACTION embarque. Pas un modele de dictee - la parole reste
 * transcrite par whisper, sans condition.
 *
 * Epingle sur une revision immuable avec son empreinte, exactement comme les six
 * modeles vocaux ci-dessus, et pour la meme raison : c'est le plus gros bloc de
 * donnees non fiables que l'application confie a un analyseur natif.
 *
 * POURQUOI CE POIDS, et le §16.5 du plan doit etre lu avec cette correction :
 * il justifiait un 3-4B par la cohabitation VRAM avec whisper. Mesure du
 * 2026-08-02 : whisper coute environ 800 MiB, il n'est donc PAS le poste qui
 * contraint. Ce qui contraint est la carte des autres gens. 1,93 Go tient sur
 * une carte de 8 Go a cote de whisper et du bureau.
 *
 * REGLE NON NEGOCIABLE : ce fichier n'est JAMAIS telecharge parce qu'une reunion
 * vient de finir. Uniquement sur pression d'un bouton. Deux gigaoctets qui
 * demarrent tout seuls a la fin d'une reunion sont le pire moment possible.
 */
export const NOTES_MODEL = {
  repo: "bartowski/Qwen2.5-3B-Instruct-GGUF",
  revision: "f302c64a2269a69fb27b2f9473b362f5bb8e78d8",
  file: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
  sha256: "9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94",
  bytes: 1_929_903_264,
} as const;

/** F8: where a redirect is allowed to land. HuggingFace bounces model downloads
 * to a CDN host that varies by region and over time, so this is a suffix rule
 * rather than a fixed list - but it is still a rule, where before there was
 * none and any 302 could send the download anywhere. */
export function redirectAllowed(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false; // never step down to http on a redirect
  const h = u.hostname.toLowerCase();
  return h === "huggingface.co" || h === "hf.co" || h.endsWith(".huggingface.co") || h.endsWith(".hf.co");
}

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
  // F8: a model this table does not name cannot be fetched at all. An unlisted
  // asset is a failure, never a pass.
  const expectedHash = MODEL_SHA256[file];
  if (!expectedHash) {
    throw new Error(`refusing to fetch "${file}": no committed SHA-256 for it in modelStore.ts`);
  }
  const dest = modelPath(file);
  if (fs.existsSync(dest)) {
    // R1: an earlier run may have left a truncated .bin (download cut, HTML stub).
    // existsSync used to short-circuit it FOREVER; validate a plausible size first.
    //
    // F8, and the limit is worth stating rather than glossing: this checks the
    // EXACT size now, not merely a floor, but it does not re-hash. Hashing a
    // gigabyte at every launch would cost seconds on the path to a warm engine,
    // for a file that was verified when it landed. So a model already on disk is
    // held to a free check; a model ARRIVING is held to the real one.
    try {
      const size = fs.statSync(dest).size;
      const want = MODEL_BYTES[file];
      if (want ? size === want : size >= MIN_MODEL_BYTES) return dest;
    } catch {
      return dest; // stat failed but the file is there: leave it, don't loop
    }
    // ADVERSE REVIEW OF F8, and this is the correction that mattered: the file
    // is NOT deleted here.
    //
    // The unlink used to fire only under the 20 MB floor - on a file that could
    // not work anyway. Tightening the check to an EXACT size widened its
    // trigger to any model from a different upstream revision: a perfectly
    // working 1.08 GB model, destroyed, and then a download attempted. On a
    // machine that is offline, or against an upstream 503, the user ends up
    // with NO model where they had a working one, and the app says "speech
    // engine unavailable". The .part-then-rename dance below promises
    // atomicity; deleting the destination first threw that promise away.
    //
    // So the old file stays put until a verified replacement is ready to take
    // its name. The worst case is now a wasted download, not a bricked engine.
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  const gotHash = await download(HF_BASE + file, tmp, onProgress);
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
  // F8: the check that matters, and it happens BEFORE the rename. Verifying
  // after would mean the unverified file had already taken the name the engine
  // loads by - and a failure there would leave it in place.
  if (gotHash !== expectedHash) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort: the .part is ours */
    }
    throw new Error(
      `INTEGRITY FAILURE for ${file}\n  expected ${expectedHash}\n  actual   ${gotHash}\n` +
        `The bytes served for this model are not the ones pinned in this build. Refusing ` +
        `to hand them to the speech engine.`,
    );
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/** Downloads to `dest` and returns the SHA-256 of what was written.
 *
 * F8: the digest is computed AS THE BYTES ARRIVE rather than by re-reading the
 * file afterwards. Not only to avoid reading a gigabyte twice - it also means
 * the hash is of what this function actually received, which a later re-read
 * could no longer promise. */
function download(url: string, dest: string, onProgress?: (pct: number) => void, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects downloading the model"));
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // F8: a 302 used to be followed anywhere at all, http included.
          const next = new URL(res.headers.location, url).toString();
          if (!redirectAllowed(next)) {
            return reject(new Error(`refusing a model redirect off the pinned host: ${next}`));
          }
          return resolve(download(next, dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`model download failed: HTTP ${res.statusCode} for ${url}`));
        }
        const total = Number(res.headers["content-length"] ?? 0);
        let got = 0;
        const hash = crypto.createHash("sha256");
        const out = fs.createWriteStream(dest);
        res.on("data", (c: Buffer) => {
          got += c.length;
          hash.update(c);
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
            resolve(hash.digest("hex"));
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
