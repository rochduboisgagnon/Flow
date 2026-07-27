import React, { useEffect, useRef } from "react";

// Home's amber ribbon (wave U1), ported from design/mockup.html's ribbon().
// This is a CLEAN module, deliberately NOT extracted from overlay.tsx: the
// overlay owns the microphone capture path and stays out of the UI campaign
// entirely. The two ribbons also differ on purpose - the overlay's stops stay
// in the #b9762a family (Roch 2026-07-22), this one uses the mockup's
// lightened stops that read on the hero card in both themes.
//
// Liveness: the rAF loop stops while the window is hidden ONLY because
// Electron's backgroundThrottling defaults to true on the main window. If
// anyone ever sets backgroundThrottling:false there, this loop burns GPU
// forever behind a hidden window - do not "fix" an unrelated problem that way.

const STOPS = ["#9c6222", "#c98a3a", "#d69745", "#c98a3a", "#9c6222"];

interface Strand {
  amp: number;
  freq: number;
  ph: number;
  sp: number;
  bob: number;
  al: number;
  sg: number;
}

export function Ribbon({ strandCount = 5, width = 420, height = 46, cssWidth = 210, cssHeight = 23, active = true }: {
  strandCount?: number;
  width?: number;
  height?: number;
  cssWidth?: number;
  cssHeight?: number;
  /** U4 (review, major): whether anything is actually being captured right now.
   * The ribbon is the same visual language as the dictation overlay's "I hear
   * you" indicator, so waving it at full amplitude while nothing is captured is
   * the app telling the user something untrue - and on the Record page it did
   * exactly that, next to the word "Idle". False renders ONE resting line, and
   * no animation loop at all.
   *
   * Defaults to true for Home's hero card, where the ribbon is decoration on a
   * page that claims nothing about a live capture. */
  active?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const W = cv.width;
    const H = cv.height;
    // Seeded LCG (mockup seed): the ribbon is identical every session, so a
    // screenshot diff against the mockup stays meaningful.
    let s = 1416;
    const rng = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const strands: Strand[] = Array.from({ length: strandCount }, () => ({
      amp: 0.2 + 0.8 * Math.pow(rng(), 1.5),
      freq: 0.85 + rng() * 1.7,
      ph: rng() * Math.PI * 2,
      sp: 0.55 + rng() * 0.9,
      bob: rng() * 2 - 1,
      al: 0.55 + 0.45 * rng(),
      sg: rng() < 0.5 ? -1 : 1,
    }));
    const span = W * 0.86;
    const x0 = (W - span) / 2;
    const maxAmp = H * 0.34;
    const grad = ctx.createLinearGradient(x0, 0, x0 + span, 0);
    STOPS.forEach((c, i) => grad.addColorStop(i / 4, c));

    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;

    // Nothing is being captured: ONE flat line at rest, drawn once. Not a
    // slowed-down wave and not an empty box - the shape stays, so the card does
    // not jump when a recording starts, but it visibly says "silent".
    function drawResting() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round";
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x0, H / 2);
      ctx.lineTo(x0 + span, H / 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function draw(now: number) {
      if (!ctx) return;
      const t = now / 1000;
      const act = 0.62; // the "visible press" activation floor, same as the overlay
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round";
      ctx.strokeStyle = grad;
      for (const st of strands) {
        ctx.beginPath();
        for (let k = 0; k <= 90; k++) {
          const tt = k / 90;
          const x = x0 + tt * span;
          const env = Math.pow(Math.sin(Math.PI * Math.pow(tt, 0.86)), 1.12);
          const wave = Math.sin(tt * st.freq * Math.PI * 2 + st.ph + t * st.sp * 1.2);
          const y = H / 2 + env * maxAmp * act * (st.amp * st.sg * wave * 0.9 + Math.sin(t * 0.45 + st.ph) * 0.32 * st.bob);
          if (k) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.globalAlpha = Math.min(1, 0.75 * st.al);
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (!reduced) raf = requestAnimationFrame(draw);
    }
    // Nothing captured -> no rAF loop at all (a hidden cost that also lied).
    if (!active) drawResting();
    // Reduced motion: one static, mid-phase frame instead of an animation.
    else if (reduced) draw(4200);
    else raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [strandCount, active]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{ width: cssWidth, height: cssHeight, display: "block" }}
      aria-hidden="true"
    />
  );
}
