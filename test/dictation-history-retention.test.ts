import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DictationHistoryStore } from "../src/main/dictationHistory";
import { HISTORY_VERSION, RETENTION_DAYS, type HistoryFile } from "../src/shared/dictationHistory";

// ---------------------------------------------------------------------------
// Security scan F3 (MEDIUM, 3/3, 2026-08-02).
//
// The 31-day retention was reachable ONLY from flush(), and flush() returns on
// its first line when nothing new was dictated. So a machine that stopped being
// used kept every transcription forever, in clear text, while the Home page
// showed the list correctly purged - read() applies the cutoff in memory and
// never writes. The user was shown a promise the disk was not keeping.
//
// Every test here fails against the old code: they all drive a store that
// records NOTHING, which is precisely the state in which the purge used to be
// unreachable.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

function seed(file: string, ages: number[], now: number): void {
  const doc: HistoryFile = {
    version: HISTORY_VERSION,
    entries: ages.map((days) => ({ at: now - days * DAY, text: `dictated ${days} days ago` })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
}

function onDisk(file: string): string[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as HistoryFile;
  return raw.entries.map((e) => e.text);
}

test("F3: start() purges expired entries from the FILE, with nothing dictated this session", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-f3-"));
  const file = path.join(work, "history.json");
  const now = Date.UTC(2026, 7, 2);
  seed(file, [1, 10, RETENTION_DAYS + 1, RETENTION_DAYS + 400], now);
  try {
    const store = new DictationHistoryStore({ file: () => file, now: () => now, flushIntervalMs: 3_600_000 });
    store.start();
    store.stop();
    assert.deepEqual(
      onDisk(file),
      ["dictated 1 days ago", "dictated 10 days ago"],
      "the expired entries must be gone from the DISK, not merely filtered out of the page",
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("F3: the six-month-later case from the scan - an install nobody dictates into again", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-f3b-"));
  const file = path.join(work, "history.json");
  const dictatedAt = Date.UTC(2026, 1, 2);
  seed(file, [0, 1, 2], dictatedAt);
  try {
    // Six months pass. Flow launches - the user never dictates - and quits.
    const sixMonthsLater = dictatedAt + 180 * DAY;
    const store = new DictationHistoryStore({
      file: () => file,
      now: () => sixMonthsLater,
      flushIntervalMs: 3_600_000,
    });
    store.start();
    store.stop();
    assert.deepEqual(onDisk(file), [], "nothing spoken six months ago may still be on this disk");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("F3: nothing expired means no write at all - the purge must not churn the file", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-f3c-"));
  const file = path.join(work, "history.json");
  const now = Date.UTC(2026, 7, 2);
  seed(file, [0, 3, 20], now);
  try {
    const before = fs.statSync(file).mtimeMs;
    const store = new DictationHistoryStore({ file: () => file, now: () => now, flushIntervalMs: 3_600_000 });
    store.start();
    store.stop();
    assert.equal(fs.statSync(file).mtimeMs, before, "a file with nothing to drop must be left untouched");
    assert.equal(onDisk(file).length, 3);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("F3: an unparseable history is still never overwritten by the purge", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-f3d-"));
  const file = path.join(work, "history.json");
  fs.writeFileSync(file, "{ this is not json", "utf8");
  try {
    const store = new DictationHistoryStore({
      file: () => file,
      now: () => Date.UTC(2026, 7, 2),
      flushIntervalMs: 3_600_000,
    });
    store.start();
    store.stop();
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "{ this is not json",
      "a file we could not understand is not ours to rewrite from what we think it said",
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("F3: a missing history file is not created by the purge", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flow-f3e-"));
  const file = path.join(work, "history.json");
  try {
    const store = new DictationHistoryStore({
      file: () => file,
      now: () => Date.UTC(2026, 7, 2),
      flushIntervalMs: 3_600_000,
    });
    store.start();
    store.stop();
    assert.equal(fs.existsSync(file), false, "no history and an empty history are different facts on a disk");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
