import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  endsInPause,
  findCutPoint,
  hms,
  transcriptLine,
  recordingBaseName,
  chunkTranscript,
  pushRecent,
  summaryPrompt,
  RECENT_MAX,
  type RecentEntry,
} from "../src/shared/longform";
import { LongRecorder } from "../src/main/longform";
import type { WhisperSidecar } from "../src/main/asr/sidecar";

const SR = 16_000;

function tone(ms: number, amp = 6000): Int16Array {
  const out = new Int16Array(Math.round((SR * ms) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amp);
  return out;
}
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((SR * ms) / 1000));
}
// Speech-LIKE audio for the recorder tests: the adaptive VAD (rightly) reads a
// constant tone as background noise, so alternate loud bursts with real gaps
// (a third of the time quiet, like syllables and breaths).
function speechy(ms: number): Int16Array {
  const parts: Int16Array[] = [];
  let left = ms;
  while (left > 0) {
    const burst = Math.min(400, left);
    parts.push(tone(burst, 7000));
    left -= burst;
    if (left > 0) {
      const gap = Math.min(200, left);
      parts.push(silence(gap));
      left -= gap;
    }
  }
  return concat(...parts);
}
function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test("endsInPause: true after 1.2 s of trailing silence, false mid-speech", () => {
  assert.equal(endsInPause(concat(tone(3000), silence(1300))), true);
  assert.equal(endsInPause(concat(tone(3000), silence(300))), false);
  assert.equal(endsInPause(tone(4000)), false);
});

test("findCutPoint lands inside the quiet stretch", () => {
  const pcm = concat(tone(10_000), silence(1000), tone(4000));
  const cut = findCutPoint(pcm, 8_000);
  // The silence spans samples [160000, 176000): the cut must fall there.
  assert.ok(cut > 10 * SR && cut < 11.05 * SR, `cut=${cut}`);
});

test("hms and transcript line formatting", () => {
  assert.equal(hms(0), "00:00:00");
  assert.equal(hms(83_000), "00:01:23");
  assert.equal(hms(3_601_000), "01:00:01");
  assert.equal(transcriptLine(83_000, "Bonjour."), "[00:01:23] Bonjour.\n\n");
});

test("recording base name: slug + stamp, accents stripped", () => {
  const d = new Date(2026, 6, 6, 14, 5);
  assert.equal(recordingBaseName("Réunion Équipe #3", d), "reunion-equipe-3-2026-07-06-1405");
  assert.equal(recordingBaseName("", d), "recording-2026-07-06-1405");
});

test("chunkTranscript splits on paragraph boundaries and loses nothing", () => {
  const para = "phrase de test assez longue pour compter.\n\n";
  const transcript = para.repeat(1200); // ~52k chars
  const parts = chunkTranscript(transcript, 24_000);
  assert.ok(parts.length >= 2);
  assert.equal(parts.join(""), transcript);
  for (const p of parts.slice(0, -1)) assert.ok(p.length <= 24_000 + para.length);
});

test("pushRecent caps at RECENT_MAX, newest first", () => {
  let list: RecentEntry[] = [];
  for (let i = 0; i < RECENT_MAX + 3; i++) {
    list = pushRecent(list, {
      title: "t" + i,
      startedIso: "",
      dir: "",
      docPath: "",
      audioPath: "",
      durationMs: 0,
    });
  }
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].title, "t" + (RECENT_MAX + 2));
});

test("summaryPrompt carries the transcript, template shape and marks", () => {
  const p = summaryPrompt("meeting", "TRANSCRIPT BODY", [83_000]);
  assert.ok(p.includes("TRANSCRIPT BODY"));
  assert.ok(p.includes("Decisions"));
  assert.ok(p.includes("00:01:23"));
  const c = summaryPrompt("client", "X", []);
  assert.ok(c.includes("Engagements"));
});

test("LongRecorder end to end with a mock engine (one document, audio kept)", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-long-"));
  const recent = path.join(work, "recent.json");
  const seen: number[] = [];
  const mockSidecar = {
    transcribe: (wav: Uint8Array) => {
      seen.push(wav.length);
      return Promise.resolve({ text: "Bonjour tout le monde.", ms: 5 });
    },
  } as unknown as WhisperSidecar;
  const rec = new LongRecorder({
    getSidecar: () => mockSidecar,
    cleanupModel: () => "",
    recentPathOverride: recent,
  });

  const started = rec.start({ dir: work, title: "Test Meeting", keepAudio: true });
  assert.equal(started.ok, true, started.error);
  assert.ok(started.audioPath && started.audioPath.endsWith(".wav"), "start must hand out the audio path");
  assert.equal(rec.isBusy, true);

  // 10 s of speech then a real pause: the segment closes naturally.
  rec.onChunk(speechy(5000));
  rec.onChunk(speechy(5000));
  rec.onChunk(concat(speechy(2000), silence(1500)));
  rec.mark();
  rec.gap(7.4);
  // More speech, stopped mid-flow: stop() closes the remainder.
  rec.onChunk(speechy(4000));
  const stopped = rec.stop();
  assert.equal(stopped.ok, true);
  assert.ok(stopped.docPath.endsWith(".md"), "stop returns the one document path");

  // finalizing drains in the background; poll it out.
  for (let i = 0; i < 100 && rec.isBusy; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.isBusy, false, "finalize must complete");

  const st = rec.state();
  assert.ok(st.segments >= 2, `segments=${st.segments}`);
  assert.equal(st.pending, 0);
  const transcript = fs.readFileSync(stopped.docPath, "utf8");
  assert.ok(transcript.includes("# Test Meeting"));
  assert.ok(transcript.includes("[00:00:00] Bonjour tout le monde."));
  assert.ok(transcript.includes("Moment marked at"));
  assert.ok(transcript.includes("Recording paused ~7s"), "the gap must be marked honestly");
  assert.ok(seen.length >= 2, "the mock engine transcribed the segments");

  const recentList = JSON.parse(fs.readFileSync(recent, "utf8"));
  assert.equal(recentList.length, 1);
  assert.equal(recentList[0].title, "Test Meeting");
  assert.ok(String(recentList[0].audioPath).endsWith(".wav"), "recent entries carry the audio path");
  fs.rmSync(work, { recursive: true, force: true });
});

test("LongRecorder refuses a missing folder and double starts", () => {
  const rec = new LongRecorder({
    getSidecar: () => null,
    cleanupModel: () => "",
    recentPathOverride: path.join(os.tmpdir(), "agrflow-long-none.json"),
  });
  const bad = rec.start({ dir: path.join(os.tmpdir(), "does-not-exist-agrflow") });
  assert.equal(bad.ok, false);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agrflow-long2-"));
  assert.equal(rec.start({ dir: work }).ok, true);
  assert.equal(rec.start({ dir: work }).ok, false, "second start must refuse");
  rec.stop();
  fs.rmSync(work, { recursive: true, force: true });
});
