import http from "node:http";
import { buildCleanupPrompt, extractCleanedText } from "../../shared/cleanup";

// Optional Ollama post-processing (plan 5.1 step 4, OFF by default): fixes
// punctuation and applies SPOKEN formatting commands ("nouvelle ligne",
// "new paragraph"...). Never required - dictation works with the ASR alone -
// and never blocking: any failure or timeout returns the original text.
// Ollama keeps everything local: still zero cloud, zero API key.

const OLLAMA_BASE = "http://127.0.0.1:11434";
const TAGS_TIMEOUT_MS = 1_000;
const GENERATE_TIMEOUT_MS = 12_000;

function request(
  path: string,
  method: "GET" | "POST",
  body: string | null,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 11434,
        path,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(`ollama ${res.statusCode}`));
          else resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ollama timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Installed model names, or null when Ollama is not running. */
export async function listOllamaModels(): Promise<string[] | null> {
  try {
    const raw = JSON.parse(await request("/api/tags", "GET", null, TAGS_TIMEOUT_MS)) as {
      models?: Array<{ name?: string }>;
    };
    return (raw.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  } catch {
    return null;
  }
}

/** One cleanup pass; the ORIGINAL text comes back on any failure. */
export async function cleanTranscript(model: string, text: string): Promise<string> {
  try {
    const body = JSON.stringify({
      model,
      prompt: buildCleanupPrompt(text),
      stream: false,
      keep_alive: "30m", // stay hot across a dictation session
      options: { temperature: 0 },
    });
    const raw = JSON.parse(await request("/api/generate", "POST", body, GENERATE_TIMEOUT_MS)) as {
      response?: string;
    };
    return extractCleanedText(raw.response ?? "", text);
  } catch {
    return text; // the LLM is a bonus, never a gate
  }
}

/** Loads the model into memory ahead of the first dictation (cold load can
 * exceed the cleanup timeout, which would silently skip the first pass). */
export function warmCleanupModel(model: string): void {
  const body = JSON.stringify({ model, prompt: "", stream: false, keep_alive: "30m" });
  request("/api/generate", "POST", body, 120_000).catch(() => {
    /* Ollama absent or model missing: cleanTranscript already degrades */
  });
}

export { OLLAMA_BASE };
