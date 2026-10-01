// use-photo-size.ts — how big a slot photo is actually drawn, so the proxy can
// send that size rather than the ~1000px original.
//
// Only the browser can answer this. The server picks a geometry for a display
// column, but the same photo is also drawn in a Screens preview — a 1280-wide
// kiosk page in an iframe scaled to under half of that — in the layout editor,
// and in a dashboard tile. A preview at 43% was downloading every face at full
// size to draw it a few hundred pixels tall.

import { useCallback, useLayoutEffect, useState, type SyntheticEvent } from "react";

import { photoSizeFor } from "@main/services/avatar-geometry";

/** Frames above this document that a real page can nest a preview in, at most. */
const MAX_FRAME_DEPTH = 8;

/** How far a loaded photo may be stretched before it counts as too small. */
const UPSCALE_TOLERANCE = 1.05;

/**
 * How much the frames above `win` scale it, multiplied together.
 *
 * A CSS transform on an <iframe> is invisible from inside it: the kiosk page in
 * a Screens preview lays out at 1280px and measures itself at 1280px, while the
 * parent draws it at a fraction of that. Same-origin frames can read their own
 * <iframe> element, whose drawn width over its layout width is exactly that
 * scale. A cross-origin parent answers `frameElement` with null, which stops the
 * walk — nothing above it can be seen, so 1 is the honest answer for it.
 */
export function frameScale(win: Window | null): number {
  let scale = 1;
  let w = win;
  for (let depth = 0; w && depth < MAX_FRAME_DEPTH; depth++) {
    const frame = w.frameElement as HTMLElement | null;
    if (!frame) break;
    const drawn = frame.getBoundingClientRect().width;
    const laidOut = frame.offsetWidth;
    if (drawn > 0 && laidOut > 0) scale *= drawn / laidOut;
    w = frame.ownerDocument.defaultView;
  }
  return scale;
}

/**
 * The box `el` covers on the physical screen, in device pixels.
 *
 * getBoundingClientRect already includes transforms inside this document (the
 * layout editor's zoom, a letterboxed canvas); frameScale adds the ones above it;
 * devicePixelRatio turns CSS pixels into the pixels a photo needs to be sharp.
 */
export function drawnBox(el: Element): { w: number; h: number } {
  const win = el.ownerDocument.defaultView;
  const r = el.getBoundingClientRect();
  const k = frameScale(win) * (win?.devicePixelRatio || 1);
  return { w: r.width * k, h: r.height * k };
}

/**
 * The `?s=` for the photo in a slot, and the two hooks it needs on the page.
 *
 * `size` is undefined until the box has been measured, so the <img> is not
 * rendered — and nothing downloaded — at a size that was only ever a guess.
 * Measured in a layout effect, so a box that already has a size gets its photo
 * in the first paint. Then a rung of the ladder, or null for "whatever geometry
 * the server chose", which is also what a box too big for the ladder gets.
 *
 * It is measured again whenever the box resizes, and each loaded photo is
 * checked against the box it has to cover; if it is stretched, the slot asks
 * for enough to cover it. That catches two things a ResizeObserver cannot: a
 * transform applied above the box after it mounted (a letterboxed layout scales
 * its canvas a frame later, which changes what is drawn and not the box), and a
 * photo whose shape is not the box's — `object-fit: cover` fills the SHORTER
 * side, so a landscape original in a tall box needs more than the longest side.
 * A transform that changes after the photo loaded (the editor's zoom, a Screens
 * window made wider) is caught on the next load.
 *
 * The size only grows, and it belongs to the slot, not to one photo. A box that
 * shrinks already has more pixels than it needs; and keeping the size when the
 * photo changes means the new URL is set on the same <img>, which holds the old
 * face on screen until the new one has loaded instead of blanking the slot.
 */
export function usePhotoSize(active: boolean): {
  size: number | null | undefined;
  /** Callback ref for the box the photo fills. */
  ref: (el: HTMLElement | null) => void;
  onLoad: (e: SyntheticEvent<HTMLImageElement>) => void;
} {
  // A callback ref held in state, so a box that mounts after the slot does (an
  // unfilled slot that gains a person) is measured when it appears.
  const [box, setBox] = useState<HTMLElement | null>(null);
  // Longest side, in device pixels, the photo has needed so far. 0 = unmeasured.
  const [needed, setNeeded] = useState(0);
  const grow = useCallback((px: number) => {
    if (px > 0) setNeeded((prev) => Math.max(prev, px));
  }, []);

  useLayoutEffect(() => {
    if (!box || !active) return;
    // Not laid out yet (display:none, detached) reads as 0 and is ignored: the
    // observer calls again once it has a size, and until then there is nothing
    // on screen to fill.
    const measure = () => {
      const { w, h } = drawnBox(box);
      grow(Math.max(w, h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [box, active, grow]);

  const onLoad = useCallback(
    (e: SyntheticEvent<HTMLImageElement>) => {
      if (!box) return;
      // What the photo has to cover now, which a transform may have changed
      // since the box was last measured, against what it actually is.
      const { w, h } = drawnBox(box);
      const img = e.currentTarget;
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
      const stretch = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      if (stretch > UPSCALE_TOLERANCE) grow(Math.max(img.naturalWidth, img.naturalHeight) * stretch);
    },
    [box, grow],
  );

  return { size: needed > 0 ? photoSizeFor(needed) : undefined, ref: setBox, onLoad };
}
