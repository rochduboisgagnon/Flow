// Named counters for the dictation hot path's "best-effort" catches (plan V2,
// B6). Every catch this module's names correspond to already existed and is
// already tolerant BY DESIGN - nothing here changes that tolerance. What was
// missing was a NAME and a COUNT for each one, so "the app feels capricious
// sometimes" becomes "overlay-send-failed fired 3 times since launch" in
// Diagnostics and the log, instead of a shrug.
//
// ZERO RETENTION (plan §5.4), same discipline as hotpath.ts: a counter is a
// NAME and a COUNT, nothing else. Never the caught error's own message, never
// a file path, never anything the user dictated - see each name's own doc
// comment below for exactly what it counts. Call sites that DO log a line
// alongside an increment (see src/main/index.ts and src/main/overlay.ts) are
// free to include `String(err)` in that separate log line - Electron/Node
// internals errors ("Object has been destroyed", "ENOSPC", ...), never
// dictation content - but the counter itself never carries it.
//
// COST, argued exactly like hotpath.ts's mark(): increment() is a Map read
// and write, no I/O, no allocation beyond the rare first-seen key. Call sites
// that run INSIDE the keyboard hook's synchronous callback chain (today:
// overlay.ts's startCapture(), reached from HotkeyAdapter's onStart) must
// increment synchronously here but DEFER any log write past the current tick
// (setImmediate) - seeing the call sites is the way to check this, not this
// file, which has no I/O at all.
//
// PURE, Electron-free (same discipline as hotpath.ts): imported by main-process
// modules directly, and its TYPES ride the existing UI_HOTPATH_SNAPSHOT
// channel (see hotpath.ts's HotpathSnapshot) out to the renderer - so it must
// stay dependency-free in both directions.

/** Closed vocabulary: a call site can never typo a free-form name into
 * something the Diagnostics panel silently fails to group under. Every entry
 * names WHAT was being attempted when the catch fired, not just "error". */
export const SILENT_FAILURE = {
  // src/main/overlay.ts - startCapture(): the cosmetic pre-send steps
  // (setAlwaysOnTop / reposition / showInactive) threw. CAPTURE_START is
  // still sent regardless (see overlaySendFailed below) - this only means the
  // pill may have shown in the wrong place, or not come to front, this press.
  overlayShowFailed: "overlay-show-failed",
  // src/main/overlay.ts - startCapture(): the CAPTURE_START IPC send itself
  // threw (e.g. the overlay's renderer process was gone). The one path where
  // the cue genuinely could not be dispatched at all for this press.
  overlaySendFailed: "overlay-send-failed",
  // src/main/overlay.ts - listMics(): the overlay's device enumeration
  // (executeJavaScript into the renderer) threw. The Settings mic list comes
  // back empty; no dictation in flight is affected.
  overlayListMicsFailed: "overlay-list-mics-failed",
  // src/main/index.ts - loadProbeWav(): the bundled probe.wav could not be
  // read, so the ASR backend was picked without the real-decode check (R1) -
  // a GPU build that loads but cannot decode would go undetected.
  probeWavLoadFailed: "probe-wav-load-failed",
  // src/main/index.ts - flowLog(): rotating the log file (stat/rename) at the
  // 1 MB mark failed; the line was appended anyway. Cosmetic (the log file
  // just grows past 1 MB once) rather than a lost diagnostic.
  flowLogRotateFailed: "flow-log-rotate-failed",
  // src/main/index.ts - flowLog(): the append itself failed (disk full,
  // permission denied, path gone). The ONLY way this is ever visible at all -
  // by construction, flowLog cannot log its own failure to write.
  flowLogWriteFailed: "flow-log-write-failed",
  // src/main/insert.ts - snapshotClipboard(): clipboard.readImage() threw
  // (a malformed image on the clipboard). The pre-dictation clipboard is
  // then snapshotted as text/html-only, and the eventual restore silently
  // drops the image flavour the user had copied.
  // NAMED HERE for the closed vocabulary; NOT WIRED - insert.ts is outside
  // this task's touchable files (see the B6 report: hotkey/insert/focus-probe
  // are recensed but not editable here).
  clipboardImageReadFailed: "clipboard-image-read-failed",
  // src/main/focus/probe.ts - probe(): the PowerShell focus probe failed to
  // start (ensureStarted() rejected). Every dictation this session falls back
  // to HOLD (clipboard-only) instead of inserting at the cursor, with nothing
  // in the UI explaining why the cursor was never touched.
  // NAMED HERE for the closed vocabulary; NOT WIRED - focus/probe.ts is
  // outside this task's touchable files (see the B6 report).
  focusProbeUnavailable: "focus-probe-unavailable",
  // src/main/index.ts - wireCapture()'s CAPTURE_DONE handler, via the pure
  // judge in shared/captureContinuity.ts (plan V2, B9).
  //
  // THE ONE ENTRY THAT IS NOT A CATCH. Every name above counts a `catch` that
  // was already there and already tolerant; this one counts a silent
  // DEGRADATION with no exception behind it at all - the microphone stopped
  // producing audio partway through a press (a USB or Bluetooth headset
  // unplugged mid-sentence, the audio service restarting, another app taking
  // the device exclusively). Nothing throws: the capture succeeds, the WAV is
  // well formed, and it simply stops where the device did. It belongs in this
  // vocabulary despite not being a catch because it fails the same test the
  // others do - the dictation was lost and no surface said so - and because
  // this is the tally the user is already reading in Diagnostics.
  micDroppedMidDictation: "mic-dropped-mid-dictation",
  // src/main/asr/batchEngine.ts - fallback(), wired in main/index.ts (plan V6, F1).
  //
  // The user configured a SEPARATE model for batch work (a recorded meeting, an
  // imported file) and batch work ran on the dictation engine instead. Like
  // micDroppedMidDictation above, this is not a catch: nothing throws, the job
  // succeeds, and the transcript is complete - it is simply less accurate (or
  // slower) than what was asked for. The realistic cause is a GPU with no room
  // left for a second resident model, and the second-most-likely is a model
  // download that failed.
  //
  // It belongs in this vocabulary for the same reason as the microphone one: a
  // setting that silently never takes effect is indistinguishable from a setting
  // that does not work, and there was no surface that could tell the difference.
  // Settings > Engine names the failure in words; this is the tally.
  batchEngineFallback: "batch-engine-fallback",
} as const;

export type SilentFailureName = (typeof SILENT_FAILURE)[keyof typeof SILENT_FAILURE];

/** A tiny in-memory tally, one process-lifetime count per name. Never
 * persisted, never reset except by a fresh process (or explicitly, for
 * tests): a counter answers "has this happened since Flow started", not
 * "has this ever happened on this machine" - the zero-retention rule (§5.4)
 * applies to counts too, not just to what they carry. */
export class SilentFailureCounters {
  private counts = new Map<SilentFailureName, number>();

  increment(name: SilentFailureName): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /** A defensively-copied snapshot for the Diagnostics panel: every KNOWN
   * name from the closed vocabulary is present, even at 0, so a consumer can
   * render a stable set of rows instead of a list that grows columns as
   * failures happen. */
  snapshot(): Record<SilentFailureName, number> {
    const out = {} as Record<SilentFailureName, number>;
    for (const name of Object.values(SILENT_FAILURE)) {
      out[name] = this.counts.get(name) ?? 0;
    }
    return out;
  }

  /** Tests only: a fresh process starts empty anyway; production code never
   * calls this (there is no "clear the diagnostics" feature, by design - a
   * counter is honest history since launch). */
  clear(): void {
    this.counts.clear();
  }
}

// The process-wide instance every main-process module increments against -
// same singleton pattern as hotpath.ts's `hotpath` export, for the same
// reason: Diagnostics and any future consumer must read the ONE tally, never
// a second copy that could disagree with it.
export const silentFailures = new SilentFailureCounters();
