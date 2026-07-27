import http from "node:http";

// Long-form Ollama support (plan §6): context expansion and meeting summaries.
// Ollama keeps everything local: zero cloud, zero API key.

const OLLAMA_BASE = "http://127.0.0.1:11434";
const TAGS_TIMEOUT_MS = 1_000;

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


/** Long-form summaries (plan §6): bigger context window, generous timeout,
 * null on any failure (the caller then ships the transcript alone). */
export async function summarize(model: string, prompt: string): Promise<string | null> {
  try {
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      keep_alive: "30m",
      options: { temperature: 0.2, num_ctx: 8192 },
    });
    const raw = JSON.parse(await request("/api/generate", "POST", body, 300_000)) as {
      response?: string;
    };
    const text = (raw.response ?? "").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export { OLLAMA_BASE };
