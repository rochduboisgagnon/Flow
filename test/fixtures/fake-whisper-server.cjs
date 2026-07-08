// A stand-in whisper-server for the R1 fallback tests: it speaks just enough of
// the real dialogue (GET / readiness, POST /inference -> verbose-less JSON) to let
// WhisperSidecar select and demote backends WITHOUT any real binary or model.
// argv: <port> <mode> [counterFile]
//   text            -> always returns non-empty text (a healthy backend)
//   empty           -> always returns "" (a GPU build that loads but decodes nothing)
//   probeok-empty   -> first inference (the decode probe) returns text, then "" forever
//   stateful-fail   -> first inference (across ALL respawns, via counterFile) returns
//                      text, every later one answers HTTP 500 (a backend that fails
//                      at inference even after the same-backend respawn+retry)
const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.argv[2]);
const mode = process.argv[3] || "text";
const counterFile = process.argv[4] || "";
let localCount = 0;

function bump() {
  if (!counterFile) return ++localCount;
  let n = 0;
  try { n = Number(fs.readFileSync(counterFile, "utf8")) || 0; } catch { /* first call */ }
  n++;
  try { fs.writeFileSync(counterFile, String(n)); } catch { /* best effort */ }
  return n;
}

function json(res, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) });
  res.end(b);
}

// Self-terminate if orphaned (a test crashed before killing us): no request for a
// while -> exit, so a timed-out run never leaves zombies holding ports.
let idle = setTimeout(() => process.exit(0), 20_000);
function touch() { clearTimeout(idle); idle = setTimeout(() => process.exit(0), 20_000); }

const server = http.createServer((req, res) => {
  touch();
  if (req.method === "GET" && req.url === "/") { res.writeHead(200); res.end("ok"); return; }
  if (req.method === "POST" && req.url === "/inference") {
    req.on("data", () => { /* drain the multipart body */ });
    req.on("end", () => {
      const n = bump();
      if (mode === "empty") return json(res, { text: "" });
      if (mode === "probeok-empty") return json(res, { text: n === 1 ? "bonjour" : "" });
      if (mode === "stateful-fail") {
        if (n === 1) return json(res, { text: "bonjour" });
        res.writeHead(500); res.end("inference failed");
        return;
      }
      return json(res, { text: "bonjour le monde" }); // "text"
    });
    return;
  }
  res.writeHead(404); res.end();
});

// findFreePort has a tiny TOCTOU window: the port it just probed can be momentarily
// taken. A real whisper-server is slow enough to miss it; this fake binds in ms, so
// retry EADDRINUSE a few times instead of dying (which the sidecar would read as
// "backend died during startup").
let tries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && tries++ < 40) {
    setTimeout(() => server.listen(port, "127.0.0.1"), 25);
  } else {
    process.exit(1);
  }
});
server.listen(port, "127.0.0.1");
