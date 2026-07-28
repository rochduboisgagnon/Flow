import { BrowserWindow, screen } from "electron";
import path from "node:path";
import {
  CAPTURE_START,
  CAPTURE_STOP,
  CAPTURE_CANCEL,
  type CaptureStartPayload,
} from "../shared/ipcContracts";
import { OverlayVisibility } from "./overlayVisibility";
import { hotpath } from "../shared/hotpath";
import { silentFailures, SILENT_FAILURE } from "../shared/silentFailures";

// The overlay window: a small transparent strip near the bottom of the screen,
// shown while dictating. HARD CONSTRAINT: it must NEVER take focus - the whole
// product inserts into the field the user was in; stealing focus would make
// the focus probe (and the insertion) target ourselves.
export class OverlayWindow {
  private win: BrowserWindow | null = null;
  // A PTT press in the first second after boot can beat the renderer's load:
  // sending CAPTURE_START into a page with no listener would silently lose the
  // dictation. Defer the last START until did-finish-load; a stop/cancel that
  // arrives meanwhile clears it (nothing was captured, nothing to deliver).
  private ready = false;
  private pendingStart: CaptureStartPayload | null = null;
  private hideTimer: NodeJS.Timeout | undefined;
  // B3: armed only by startAndRefuse() below - cleared by the NEXT startCapture()
  // (real or another refusal), same discipline as hideTimer just above.
  private refusalTimer: NodeJS.Timeout | undefined;
  // How long a refused press (see startAndRefuse) stays up before it self-cancels.
  // A same-tick showInactive()+hide() can paint NOTHING at all (the compositor never
  // gets a turn between the two native calls) - this yields to the event loop long
  // enough for a real frame, while staying comfortably under a deliberate hold so it
  // never reads as a real, if short, dictation (MIN_HOLD_MS is 200 ms).
  private static readonly REFUSAL_FLASH_MS = 260;
  // Overlap guard (bug Roch: sometimes the animation does not show on press). The window is SHARED
  // and persistent; re-pressing PTT while the previous utterance was still finalizing let the OLD
  // flowDone()/safety-timer hide the NEW capture. The hide policy lives in a pure, unit-tested state
  // machine (overlayVisibility.ts); here we just show/hide when it says so.
  private vis = new OverlayVisibility();
  // B6: optional, matching FocusProbe/NativeCapture's own constructor convention -
  // injected once from index.ts (flowLog) so a failure IN HERE stops being invisible
  // too. Never called synchronously from startCapture()'s hot path - see there.
  constructor(private readonly log?: (msg: string) => void) {}

  create(dev: boolean) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    // The overlay is a horizontal PILL (stadium) holding the amber ribbon (renderer/overlay.tsx,
    // 2026-07-23). The window only has to contain that pill (canvas 92x26 + ~7/16 px padding) plus
    // its soft shadow without clipping; it stays transparent + click-through, so this size is
    // invisible. Bottom-anchored, so height is what would move the pill vertically - keep it just
    // large enough for the pill + shadow, and in step with the pill's padding in overlay.tsx.
    // The slim pill (canvas 92x18 + ~5/16 px padding = ~124x28) is centered in this window, so
    // shrinking the pill keeps its on-screen position; no need to change W/H for the slim tweak.
    const W = 160;
    const H = 70;
    this.win = new BrowserWindow({
      width: W,
      height: H,
      x: Math.round((width - W) / 2),
      y: height - H - 24,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false, // never steal focus from the dictation target
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed preloads cannot require() relative files (Electron 20+):
        // ours pulls ../shared/ipcContracts, so the preload silently failed to
        // load and window.agrflow never existed - no capture at all in the
        // packaged app. contextIsolation stays on; both windows load only our
        // own local pages.
        sandbox: false,
        // The window is hidden between dictations; without this, Chromium throttles the
        // canvas requestAnimationFrame and the ribbon can be blank or late right after a
        // showInactive(). Keep it painting so the animation is there the instant it shows.
        backgroundThrottling: false,
        // The opt-in start/stop cue is synthesized in this renderer; there is no DOM user
        // gesture (the PTT keypress lives in the native hook), so allow autoplay explicitly.
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setIgnoreMouseEvents(true); // clicks pass through to whatever is under it
    this.win.webContents.on("did-finish-load", () => {
      this.ready = true;
      if (this.pendingStart) {
        const cfg = this.pendingStart;
        this.pendingStart = null;
        this.startCapture(cfg);
      }
    });
    if (dev) this.win.loadURL("http://localhost:5183/overlay.html");
    else this.win.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
  }

  startCapture(cfg: CaptureStartPayload) {
    if (!this.win || this.win.isDestroyed()) return;
    // A new press takes over the shared window: any pending hide from a previous
    // utterance is now stale and must not fire.
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    // B3: likewise for a still-pending refusal auto-cancel (startAndRefuse) - without
    // this, a refusal immediately followed by a REAL press would let that stale timer
    // cancel the real capture out from under the user a quarter-second later.
    clearTimeout(this.refusalTimer);
    this.refusalTimer = undefined;
    this.vis.onStart();
    if (!this.ready) {
      this.pendingStart = cfg;
      return;
    }
    // B3: cosmetic positioning must never cost the user the cue itself - the send()
    // below is what actually plays the sound and starts the mic, and is attempted
    // regardless of whether this block throws. (This call stack is reached directly
    // from HotkeyAdapter's un-guarded key-event handler in hotkey.ts, which has no
    // try/catch of its own around cbs.onStart() - an uncaught throw here would not
    // just cost this ONE cue, it risks the keyboard hook itself.)
    try {
      this.win.setAlwaysOnTop(true, "screen-saver"); // re-assert above any fullscreen app
      this.reposition(); // anchor on the display under the cursor (multi-monitor)
      this.win.showInactive(); // show WITHOUT focusing
    } catch (err) {
      // B6: named, counted, logged - but the log write is DEFERRED past this tick
      // (setImmediate). flowLog does a synchronous fs.appendFileSync; running it here
      // would put real disk I/O on the exact call stack B1's budget exists to protect.
      silentFailures.increment(SILENT_FAILURE.overlayShowFailed);
      const msg = String(err);
      setImmediate(() => this.log?.(`[overlay] show failed: ${msg}`));
    }
    // B1: marked HERE, right before the dispatch - not in HotkeyAdapter's
    // onStart - because setAlwaysOnTop/reposition/showInactive (above) are
    // real, sometimes non-trivial main-thread work that this order actually
    // waits on.
    hotpath.mark("overlayStartSent");
    try {
      this.win.webContents.send(CAPTURE_START, cfg);
    } catch (err) {
      // B3/B6: THE guarantee - see the module note above. Still best-effort: a
      // renderer that is genuinely gone cannot be made to play a cue no matter what
      // main does: this is the one path where the cue could not be dispatched at all.
      silentFailures.increment(SILENT_FAILURE.overlaySendFailed);
      const msg = String(err);
      setImmediate(() => this.log?.(`[overlay] CAPTURE_START send failed: ${msg}`));
    }
  }

  /** B3: a press main refuses for a reason that has nothing to do with the overlay
   * itself (today: index.ts's onStart bails when a long recording owns the engine)
   * must still be FELT - the plan's contract is "the sound, the animation remain
   * always there" on EVERY rising edge, refusal included. This fires the identical
   * start signal a real capture would (cue + pill + an armed mic session in the
   * renderer - see overlay.tsx's start()), then cancels it after a short,
   * deliberately visible beat instead of dropping the press in total silence.
   * cancelCapture() tears down whatever the renderer had started (its `gen` token)
   * before any WAV - and therefore any engine call - can ever happen: the long
   * recording keeps the ASR sidecar to itself, exactly as before. */
  startAndRefuse(cfg: CaptureStartPayload) {
    this.startCapture(cfg);
    this.refusalTimer = setTimeout(() => {
      this.refusalTimer = undefined;
      this.cancelCapture();
    }, OverlayWindow.REFUSAL_FLASH_MS);
  }

  stopCapture() {
    this.pendingStart = null;
    this.vis.onStop();
    if (!this.win || this.win.isDestroyed()) return;
    hotpath.mark("overlayStopSent");
    this.win.webContents.send(CAPTURE_STOP);
    // Stay visible: the renderer shows "Transcribing..." until the text is routed
    // (flowDone), hiding the model's latency behind honest feedback. A safety timer
    // guarantees the overlay can never linger forever, even if a pipeline never signals.
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.vis.onSafetyTimeout()) this.hideNow();
    }, 10_000);
  }

  /** The utterance finished its journey (inserted, clipboarded, or dropped). */
  flowDone() {
    if (this.vis.onDone()) this.hideNow();
  }

  cancelCapture() {
    this.pendingStart = null;
    if (!this.win || this.win.isDestroyed()) return;
    hotpath.mark("overlayCancelSent");
    this.win.webContents.send(CAPTURE_CANCEL);
    // A tapped/aborted press must not yank the overlay from under a PREVIOUS utterance
    // that is still transcribing: only hide when nothing is live.
    if (this.vis.onCancel()) this.hideNow();
  }

  private hideNow() {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
  }

  /** Anchor the strip at the bottom-centre of the display under the cursor, recomputed on
   * each press: the create()-time position is fixed to the primary display, so dictating on
   * a second monitor would put the ribbon on the wrong screen ("it did not show"). */
  private reposition() {
    if (!this.win || this.win.isDestroyed()) return;
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = this.win.getSize();
    this.win.setPosition(
      Math.round(wa.x + (wa.width - w) / 2),
      Math.round(wa.y + wa.height - h - 24),
    );
  }

  /** Microphone list for the Manager's settings view. Device enumeration
   * needs a renderer; the overlay page exposes window.__agrflowListMics
   * (main world, so executeJavaScript reaches it despite contextIsolation). */
  async listMics(): Promise<Array<{ id: string; label: string }>> {
    if (!this.win || this.win.isDestroyed() || !this.ready) return [];
    try {
      const out = (await this.win.webContents.executeJavaScript(
        "window.__agrflowListMics ? window.__agrflowListMics() : []",
        true,
      )) as Array<{ id: string; label: string }>;
      return Array.isArray(out) ? out : [];
    } catch (err) {
      // B6: was silent. On-demand from Settings, never inside the keyboard hook's
      // call stack, so a synchronous log line here costs nothing that matters.
      silentFailures.increment(SILENT_FAILURE.overlayListMicsFailed);
      this.log?.(`[overlay] listMics failed: ${String(err)}`);
      return [];
    }
  }

  destroy() {
    this.win?.destroy();
    this.win = null;
  }
}
