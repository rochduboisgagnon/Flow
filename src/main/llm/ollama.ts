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

/** U8: one SHORT generation, abortable.
 *
 * Deliberately a second entry point rather than a parameter on summarize():
 * that one is the finalize path, the most-reviewed call in this file, and it
 * wants a 5-minute budget and a big context. This one runs DURING a meeting and
 * needs the opposite of all three - a small context, a hard cap on the number
 * of tokens produced, and above all the ability to be dropped mid-flight.
 *
 * `signal` is what makes "the assistance yields to the engine" real rather than
 * a comment: destroying the request is the only lever this process has to stop
 * a local model from holding the GPU while whisper needs it for a dictation or
 * for the meeting's own transcription. It is a lever, not a guarantee - Ollama
 * may finish the batch it started - so the ordering gate in
 * shared/liveAssist.ts (never START a round while the engine is busy) remains
 * the primary protection and this is the second line.
 *
 * null on ANY failure (not running, aborted, timed out, empty answer): the
 * caller shows an honest "nothing this round" rather than an error the user can
 * do nothing about. */
export async function generateShort(
  model: string,
  prompt: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; numCtx?: number; numPredict?: number } = {},
): Promise<string | null> {
  const body = JSON.stringify({
    model,
    prompt,
    stream: false,
    keep_alive: "10m",
    options: {
      temperature: 0.3,
      num_ctx: opts.numCtx ?? 4096,
      // The one bound that keeps a round short even if the model wants to write
      // an essay: three glanceable lines need very few tokens.
      num_predict: opts.numPredict ?? 220,
    },
  });
  try {
    const raw = JSON.parse(
      await abortableRequest("/api/generate", body, opts.timeoutMs ?? 30_000, opts.signal),
    ) as { response?: string };
    const text = (raw.response ?? "").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** POST with an AbortSignal. Kept apart from request() above so the summarize
 * path this module was written for keeps exactly the code it had. */
function abortableRequest(
  path: string,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted before start"));
      return;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 11434,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
    const onAbort = () => {
      req.destroy(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Removing the listener on EVERY exit path matters: a long meeting runs
    // dozens of rounds against one long-lived controller-free signal chain, and
    // a listener left behind per round is a leak with a warning attached.
    const done = () => signal?.removeEventListener("abort", onAbort);
    req.on("close", done);
    req.on("error", (err) => {
      done();
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ollama timed out"));
    });
    req.write(body);
    req.end();
  });
}

export { OLLAMA_BASE };
