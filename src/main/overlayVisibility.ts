// The overlay window is SHARED and persistent, and its show/hide is driven by events that can
// overlap: a new push-to-talk press can arrive while the PREVIOUS utterance is still finalizing
// (decode + insert). The bug (Roch: "sometimes the animation does not show on press") was the old
// utterance's flowDone()/safety-timer hiding the NEW capture. This tiny state machine is the policy,
// kept PURE (no Electron) so it can be unit-tested: OverlayWindow owns the actual BrowserWindow and
// only asks "should I hide now?".
//
// Invariant: the overlay is visible while a press is ACTIVE (capturing) OR any utterance is still in
// flight (pending > 0). It hides only when nothing is live.
export class OverlayVisibility {
  private capturing = false;
  private pending = 0; // utterances between onStop() and onDone()

  /** A press started (or resumed). The overlay must stay up; any pending hide is now stale. */
  onStart(): void {
    this.capturing = true;
  }

  /** The press was released: capture ends, its utterance enters the transcription pipeline. */
  onStop(): void {
    this.capturing = false;
    this.pending++;
  }

  /** One utterance finished its journey (inserted, clipboarded, or dropped). Returns whether to hide. */
  onDone(): boolean {
    if (this.pending > 0) this.pending--;
    return this.shouldHide();
  }

  /** A press was tapped/aborted (below the hold threshold). Returns whether to hide. */
  onCancel(): boolean {
    this.capturing = false;
    return this.shouldHide();
  }

  /** The safety timer fired: a stuck pipeline must not pin the overlay open forever. Returns whether
   * to hide. Clears the in-flight count, but still yields to an ACTIVE press. */
  onSafetyTimeout(): boolean {
    this.pending = 0;
    return !this.capturing;
  }

  private shouldHide(): boolean {
    return !this.capturing && this.pending === 0;
  }
}
