#!/usr/bin/env node
// Verify a downloaded native dependency against the hash committed in
// scripts/native-deps.json - see that file for why this exists.
//
// Used two ways:
//   node scripts/verify-native-deps.cjs <group> <file>   verify, exit 1 on mismatch
//   node scripts/verify-native-deps.cjs --print          recompute from the network
//
// Deliberately dependency-free and synchronous: it runs inside a release job
// between a download and an extraction, and anything it required would itself
// be one more thing to trust at exactly the moment trust is the subject.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");

const MANIFEST = path.join(__dirname, "native-deps.json");

function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Verify one downloaded file. Throws - loudly, with both hashes - on mismatch. */
function verify(group, filePath) {
  const m = manifest();
  const entry = m[group];
  if (!entry) throw new Error(`native-deps.json has no group "${group}"`);
  const name = path.basename(filePath);
  const expected = entry.assets[name];
  // An asset absent from the manifest is a FAILURE, never a pass. Otherwise the
  // check silently stops applying the day someone adds a third binary.
  if (!expected) {
    throw new Error(
      `${name} is not listed in native-deps.json under "${group}". ` +
        `Add it with its hash, or this build ships a binary nobody vouched for.`,
    );
  }
  const actual = sha256(filePath);
  if (actual !== expected) {
    throw new Error(
      `INTEGRITY FAILURE for ${name}\n` +
        `  expected ${expected}\n` +
        `  actual   ${actual}\n` +
        `The upstream bytes changed. Either the release was re-uploaded (check with the\n` +
        `maintainer before trusting it) or this download was tampered with. Refusing to\n` +
        `package it.`,
    );
  }
  console.log(`[verify-native-deps] ${name} matches the committed hash`);
}

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "flow-verify-native-deps" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const next = res.headers.location;
          if (!next || !next.startsWith("https:")) return reject(new Error("refusing a non-https redirect"));
          res.resume();
          return resolve(get(next));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

/** Recompute every hash from the pinned versions, for updating the manifest. */
async function print() {
  const m = manifest();
  for (const [group, entry] of Object.entries(m)) {
    if (group.startsWith("_")) continue;
    for (const name of Object.keys(entry.assets)) {
      const url = `https://github.com/${entry.repo}/releases/download/${
        group === "keyspy" ? "v" : ""
      }${entry.version}/${name}`;
      const buf = await get(url);
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      const same = hash === entry.assets[name];
      console.log(`${same ? "  same" : "CHANGED"}  ${group}/${name}\n         ${hash}`);
    }
  }
}

const [, , a, b] = process.argv;
if (a === "--print") {
  print().catch((err) => {
    console.error(String(err.message || err));
    process.exit(1);
  });
} else if (a && b) {
  try {
    verify(a, b);
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
} else {
  console.error("usage: verify-native-deps.cjs <group> <file> | --print");
  process.exit(2);
}

module.exports = { verify, sha256 };
