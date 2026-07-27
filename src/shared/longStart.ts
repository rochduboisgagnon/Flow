// U4a: the one long-form IPC channel that needs more than a straight
// pass-through to the recorder. Kept pure and out of uiBridge.ts (which
// cannot be instantiated outside a real Electron process - see the module
// note atop test/ui-bridge.test.ts) so this decision is unit-tested directly,
// no mocks, the same discipline as shared/route.ts and shared/textGate.ts.
import type { LongAudioSource } from "./ipcContracts";

export type LongStartDecision =
  | { ok: true; captureSystem: boolean; title?: string; keepAudio: boolean }
  | { ok: false; error: string };

function isValidSource(v: unknown): v is LongAudioSource {
  return v === "mic" || v === "system" || v === "both";
}

/**
 * Turns a renderer-supplied UI_LONG_START payload into either the
 * longStartNative() call the handler should make, or a clean refusal -
 * never an exception, never a captureSystem (or a microphone) the caller did
 * not actually ask for.
 *
 * `canLoopback` mirrors NativeCapture.available() (Windows-only, "this is a
 * PC" gate). It gates EVERY source, not just "system"/"both": the native
 * capture window (main/capture.ts) is the only mechanism this app has today
 * to feed its own microphone into a long-form recording, so "mic" needs it
 * exactly as much as "both" does.
 *
 * "system" (the PC's own sound, no microphone) is refused even when
 * canLoopback is true: the native capture renderer
 * (src/renderer/capture.tsx) calls getUserMedia UNCONDITIONALLY today, so
 * silently keeping the microphone on while the user asked for "system" would
 * be exactly the lying success this channel must never produce. The type
 * still names the choice (shared/ipcContracts.ts's LongAudioSource) so a
 * future renderer change can make it real without touching this contract -
 * only this one refusal branch needs to move.
 */
export function decideLongStart(input: unknown, canLoopback: boolean): LongStartDecision {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "missing start options" };
  }
  const req = input as Record<string, unknown>;
  if (!isValidSource(req.source)) {
    return { ok: false, error: "invalid audio source (expected mic, system, or both)" };
  }
  if (!canLoopback) {
    return { ok: false, error: "long-form recording needs native capture, only available on a Windows PC" };
  }
  if (req.source === "system") {
    return { ok: false, error: "PC sound without the microphone is not supported yet" };
  }
  const title = typeof req.title === "string" ? req.title : undefined;
  const keepAudio = req.keepAudio === true;
  return { ok: true, captureSystem: req.source === "both", title, keepAudio };
}
