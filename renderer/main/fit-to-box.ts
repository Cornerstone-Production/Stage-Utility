// fit-to-box.ts — the one measurement that makes a thing fit its box.
//
// Slide text, service items, the people panel and Lyrics all answer "how big can
// this be and still fit?", and used to answer it three ways. This is the single
// answer: bisect a size between a floor and a ceiling and keep the largest at
// which the content fits.
//
// BISECTION, not a back-derived scale. A scale taken from the natural size is
// exact only for content that does not wrap; wrapped text changes height in
// jumps as its size changes, so the back-derived guess lands on a size that
// either overflows or leaves the box half empty (Current slide stopped at 65px in
// a box that held 150px). Every probe runs inside one layout effect, mutating the
// element directly, so none is painted.

import { useLayoutEffect, useRef, useState } from "react";
import { useLatestRef } from "@renderer/lib/use-latest-ref";

/** Halvings of the search range: the answer is within a fraction of a unit. */
const FIT_STEPS = 12;

/**
 * The largest value in [floor, ceiling] at which `fits` holds, trying the ceiling
 * first (an object that fits at its ceiling is exactly the ceiling). When nothing
 * fits, the floor: small, never invisible.
 */
export function largestFit(floor: number, ceiling: number, fits: (v: number) => boolean): number {
  if (fits(ceiling)) return ceiling;
  let lo = floor;
  let hi = ceiling;
  for (let i = 0; i < FIT_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface BoxFit<T extends HTMLElement> {
  /** The range searched, as numbers or as a function of the measured box (a size
   *  that is a share of the box's own height cannot be known before it is). */
  floor: number | ((box: { w: number; h: number }) => number);
  ceiling: number | ((box: { w: number; h: number }) => number);
  /** What the value is before the box has been measured, and wherever it never is
   *  (jsdom has no layout): a plausible first paint rather than none. */
  initial: number;
  /** Measure again when this changes: whatever changes the content's size. */
  contentKey: string;
  /** Puts a value on the content: a font size, or a scale. */
  apply: (content: T, value: number) => void;
  /** Whether the content, with the value applied, fits the box. Defaults to the
   *  content's own height and width being no larger than the box's. */
  fits?: (wrap: HTMLElement, content: T, value: number) => boolean;
}

const contentFits = (wrap: HTMLElement, content: HTMLElement) =>
  content.offsetHeight <= wrap.clientHeight && content.scrollWidth <= wrap.clientWidth + 1;

/**
 * The fitted value, and the two elements it is measured against: put `wrapRef` on
 * the box and `contentRef` on what must fit it. Measures again when the box
 * resizes, when `contentKey` changes, and once the fonts have loaded (a measure
 * taken in the fallback face is wrong for the face that replaces it).
 */
export function useBoxFit<T extends HTMLElement = HTMLElement>(opts: BoxFit<T>) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<T | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [fonts, setFonts] = useState(0);
  const [value, setValue] = useState<number | null>(null);
  // The latest callbacks, without making each render a reason to measure again.
  const latest = useLatestRef(opts);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let live = true;
    // `document.fonts` is absent in some embedded browsers; there, nothing to wait for.
    void document.fonts?.ready.then(() => {
      if (live) setFonts((n) => n + 1);
    });
    return () => {
      live = false;
      ro.disconnect();
    };
  }, []);

  const floor = typeof opts.floor === "function" ? opts.floor(box) : opts.floor;
  const ceiling = typeof opts.ceiling === "function" ? opts.ceiling(box) : opts.ceiling;
  const { contentKey } = opts;
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const content = contentRef.current;
    if (!wrap || !content || box.h <= 0 || box.w <= 0) return;
    const { apply, fits } = latest.current;
    const best = largestFit(floor, ceiling, (v) => {
      apply(content, v);
      return fits ? fits(wrap, content, v) : contentFits(wrap, content);
    });
    apply(content, best);
    setValue(best);
  }, [floor, ceiling, contentKey, box.w, box.h, fonts, latest]);

  return { wrapRef, contentRef, box, value: value ?? opts.initial };
}
