// How the context bar fits itself into the width it has.
//
// The strip never scrolls and never wraps, at any width from 320px up. Both of
// those were fixes once and both were wrong: wrapping cost a phone a second band
// of a screen that has none to spare, and scrolling pushed "6 disconnected" past
// the right edge — an alert you have to swipe sideways to find is not an alert.
//
// So the bar gives things up instead, in a fixed order, and the order is the
// whole design. Each rung removes A WORD, A QUALIFIER OR A DECORATION and
// nothing else:
//
//   0  full          Everything at its full length.
//   1  qualifiers    The clock's seconds; the capsule's inning/period detail;
//                    the timer's pre-service label. Each is context the operator
//                    already has, and none of them is an item's only reading.
//   2  compact       Every idle WORD becomes that item's own mark, gaps and edge
//                    padding tighten from 12px to 8px, and the score capsule
//                    tightens. "6 disconnected" keeps its 6 and loses the word.
//   3  floor         Prose — a service type, a plan title, a live item's title —
//                    ellipsises.
//
// FOUR THINGS THE LADDER MAY NEVER DO. Never remove a number: a score, a count,
// a countdown, a duration. Never remove a state colour: live green, overrun red.
// Never drop an item: every reading on the strip is one somebody put there on
// purpose. Never scroll and never wrap.
//
// "NEVER DROP AN ITEM" INCLUDES CLIPPING ITS ONLY READING. Level 1 used to take
// the service-type name, which was legal while that name was a qualifier printed
// inside the plan item — the rung shortened one item rather than emptying one.
// Now that the service type is an item in its own right, taking it would leave a
// row that renders to zero width and still charges the strip a gap. A rung may
// only ever take a word an item can spare.
//
// LEVEL 3 IS A FLOOR, NOT A STEP. It exists because a strip that cannot fit has
// to do SOMETHING, and of the four things it could do — ellipsise, wrap, scroll,
// or clip — only ellipsising keeps one row, keeps every number, and tells the
// reader that a word was cut. It is not meant to be reached: the phone has its
// own item set precisely so prose can be curated off it, and the configurator
// says so while you are choosing. A bar with no prose item on it can never land
// here.
//
// The walk is GLOBAL — every item is on the same rung at once — so the bar keeps
// one shape you can learn, rather than eight items each deciding for themselves.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The lowest rung. Levels are 0..BAR_FIT_FLOOR. */
export const BAR_FIT_FLOOR = 3;

/**
 * The rung this strip should be on, given a way to ask whether a rung fits.
 *
 * Pure, and separated from the DOM on purpose: the arithmetic is what can be
 * tested off a browser, and the measuring is what cannot.
 *
 * IT STARTS FROM WHERE IT IS rather than from the top, and that is not an
 * optimisation detail — it is what keeps the common case to one measurement.
 * Every read of `scrollWidth` forces a synchronous layout, and this runs on
 * every render of a strip carrying a clock that ticks once a second. Walking
 * 0,1,2,3 unconditionally would force four layouts a second on a bar that has
 * not changed width since it was mounted.
 *
 * Climbing back up is safe because the rungs are MONOTONE: each one only ever
 * removes, so a rung is never wider than the one above it. That is what rules
 * out the oscillation an adaptive layout usually has to add hysteresis for — if
 * level n fits, every level below n fits too, so there is no width at which the
 * fitter can flip between two answers.
 */
export function chooseFitLevel(current: number, fitsAt: (level: number) => boolean): number {
  const from = Math.min(Math.max(current, 0), BAR_FIT_FLOOR);

  if (!fitsAt(from)) {
    // Too wide. Give something up until it goes in, or bottom out on the floor —
    // where prose ellipsises, so it always does.
    for (let lv = from + 1; lv <= BAR_FIT_FLOOR; lv++) {
      if (fitsAt(lv)) return lv;
    }
    return BAR_FIT_FLOOR;
  }

  // It fits. Take back as much as still fits, so a bar that got its room returns
  // to full rather than staying compact until something forces a re-fit.
  let lv = from;
  while (lv > 0 && fitsAt(lv - 1)) lv--;
  return lv;
}

/**
 * Keep an element on the rung that fits it.
 *
 * Returns the ref to put on the strip and the level it landed on. The level is
 * written to `data-fit` on the element itself — the ladder is expressed in CSS
 * keyed off that attribute — and also returned, because the configurator shows
 * the operator which rung their arrangement lands on.
 *
 * Re-fits after every render, and on resize. After every render is deliberate
 * rather than lazy: the readings change under this component constantly, and a
 * dependency list naming the ones that affect width is a list somebody adds the
 * ninth item to and forgets. The measurement is cheap precisely because
 * `chooseFitLevel` starts from where it is — see there.
 */
export function useBarFit<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  level: number;
  /**
   * Pixels the strip is over its box once it has given up everything it can.
   * Zero for every arrangement that fits.
   *
   * REPORTED RATHER THAN ASSUMED, because the floor does not always save it. The
   * floor works by letting prose ellipsise, so an arrangement with no prose on
   * it — all numbers and marks — has nothing left to give and can still be too
   * long. `overflow: hidden` keeps that from printing over the page, but a
   * silently clipped reading is the one failure this bar must not have quietly,
   * so the number comes out here and the configurator says it out loud.
   */
  over: number;
} {
  const ref = useRef<T | null>(null);
  const [level, setLevel] = useState(0);
  const [over, setOver] = useState(0);
  // The level the DOM is actually on, read by the next fit. Kept in a ref rather
  // than read back off `level`: setState is async, so two fits in one frame —
  // a render and a resize — would both start from the stale value.
  const at = useRef(0);

  const refit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = chooseFitLevel(at.current, (lv) => {
      el.dataset.fit = String(lv);
      // scrollWidth is rounded to an integer and clientWidth is not, so a strip
      // that fits exactly can read one pixel over. The half-pixel is what stops
      // that rounding alone dropping a rung.
      return el.scrollWidth <= el.clientWidth + 0.5;
    });
    el.dataset.fit = String(next);
    at.current = next;
    const short = Math.max(0, Math.round(el.scrollWidth - el.clientWidth));
    setLevel((prev) => (prev === next ? prev : next));
    setOver((prev) => (prev === short ? prev : short));
  }, []);

  // Layout, not passive: the level has to be settled before the browser paints,
  // or the bar shows one frame at full length and snaps.
  useLayoutEffect(refit);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [refit]);

  return { ref, level, over };
}
