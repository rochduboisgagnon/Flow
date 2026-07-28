import fs from "node:fs";
import path from "node:path";
import { DownloadManager, PART_SUFFIX } from "../../src/main/downloads";

// A REAL process death in the middle of a REAL copy (U5 review, MAJEUR 1).
//
// Spawned by test/downloads.test.ts. It starts a genuine DownloadManager audio
// download and then SIGKILLs ITSELF the moment bytes are on disk: no exit hook,
// no finally, no cleanup - exactly what an updater relaunch, a power loss or a
// forced quit does to a copy in flight, and the one failure the module's own
// error handling can never cover. Whatever the Downloads folder holds at that
// instant is what the user is left with, and that is what the parent asserts on.
//
// argv: <historyRoot> <downloadsDir> <historyId>

const [historyRoot, downloadsDir, id] = process.argv.slice(2);

const mgr = new DownloadManager({ historyRoot: () => historyRoot, downloadsDir: () => downloadsDir });
void mgr.downloadAudio(id);

// The copy advances one stream chunk per event-loop turn, so this poll gets
// many chances to fire long before the last byte of a multi-megabyte source.
// The kill waits for a NON-EMPTY work file: dying before a single byte is
// written would prove nothing about a half-copied file.
const watch = setInterval(() => {
  let names: string[];
  try {
    names = fs.readdirSync(downloadsDir);
  } catch {
    return;
  }
  const part = names.find((n) => n.endsWith(PART_SUFFIX));
  if (!part) return;
  let size = 0;
  try {
    size = fs.statSync(path.join(downloadsDir, part)).size;
  } catch {
    return;
  }
  if (size <= 0) return;
  clearInterval(watch);
  // On Windows this is TerminateProcess; on POSIX, an uncatchable SIGKILL.
  // Either way nothing of ours runs afterwards.
  process.kill(process.pid, "SIGKILL");
}, 1);
