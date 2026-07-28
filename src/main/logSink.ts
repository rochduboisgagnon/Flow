import fs from "node:fs";
import { type LogSink } from "../shared/logQueue";

// The two lines of real disk I/O behind the engine log (plan V2, B4b). All the
// policy - ordering, buffering, rotation timing, what a failure means - lives in
// the pure src/shared/logQueue.ts; this file is only the adapter that actually
// touches the filesystem, exactly like main/asr/sidecar.ts's spawn seam.
//
// TWO DELIBERATE CHOICES, both about keeping syscalls off the event loop that
// owes Windows a keyboard-hook verdict (menace §3.2.2):
//
//   1. `append` is fs.appendFile (ASYNCHRONOUS). Deferring a SYNCHRONOUS append
//      to a later tick would not have been enough: keyspy delivers key events as
//      stdout "data" on this same loop, so a blocking write on any tick still
//      delays the next verdict. Only handing the write to libuv's threadpool
//      leaves the loop free.
//   2. The file's size is COUNTED, not stat'ed. The old flowLog ran an
//      fs.statSync per LINE; a naive port would have run one per drain. Instead
//      this measures the file once (lazily, the first time rotation has to be
//      judged) and then adds the bytes it writes itself. Flow is the only writer
//      of flow.log, so the count is right; if someone deletes the file behind
//      our back the only consequence is a rotation decided on a stale number,
//      which costs nothing.

const ROTATED_SUFFIX = ".1";

export function createFileLogSink(filePath: () => string): LogSink {
  // Resolved at WRITE time, never at construction: dataDir() caches its answer
  // on the first call, and that answer must be the POST-migration folder (see
  // main/settings.ts). Constructing this sink must therefore not pin it.
  let known: number | null = null;

  return {
    append(text, done) {
      const p = filePath();
      fs.appendFile(p, text, (err) => {
        if (!err && known !== null) known += Buffer.byteLength(text);
        done(err ?? undefined);
      });
    },

    appendSync(text) {
      // before-quit only: there is no later tick left to run on, so this is the
      // one place a synchronous write is the correct answer rather than the bug.
      fs.appendFileSync(filePath(), text);
      if (known !== null) known += Buffer.byteLength(text);
    },

    size() {
      // Throws when there is no file yet (first run). LogQueue treats that as
      // "nothing to rotate", which is exactly right.
      if (known === null) known = fs.statSync(filePath()).size;
      return known;
    },

    rotate() {
      const p = filePath();
      fs.renameSync(p, p + ROTATED_SUFFIX);
      known = 0;
    },

    schedule(fn) {
      // setImmediate, not setTimeout(0) and not process.nextTick: it runs after
      // the current I/O callbacks (so a burst of whisper-server stderr lines
      // becomes ONE write) but still on this turn of the loop, so the log is
      // never more than a tick behind reality. nextTick would run BEFORE the
      // loop yields, which is the one thing this must not do.
      setImmediate(fn);
    },
  };
}
