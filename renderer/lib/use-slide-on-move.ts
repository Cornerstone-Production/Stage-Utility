// use-slide-on-move.ts — slide every card that moved, from where it was to
// where it now is.
//
// Layout does not animate: a card that changes grid cells, or that leaves one
// group of a list for another, jumps. This is the standard FLIP — measure before
// the paint, apply the inverse as a transform so the card appears not to have
// moved, then release it on the next frame and let a transition carry it across.
// Without it, "the other cards move out of the way" is a teleport, which reads
// as the page glitching rather than as the page making room.
//
// Home's widget grid had this first. The Integrations page needs exactly the
// same thing when enabling an integration moves its card out of "Not set up",
// so it lives here rather than being written a second time.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** Cards keyed by id survive being remounted somewhere else, which a card that
 *  changes GROUP does — so the before/after pair is found by id, not by node. */
const DEFAULT_ID_ATTRIBUTE = "data-card-id";

/** How long a card takes to travel. Exported so a caller that has to act once
 *  the card has landed — scrolling to it, say — waits the right amount. */
export const SLIDE_MS = 180;

/** Does this viewer want motion at all?
 *
 * Asked here, in JS, and not left to the global CSS override: that rule cannot
 * reach an inline `style.transform`, which is what a FLIP writes. Read at the
 * moment of the move rather than cached, so changing the system setting takes
 * effect without a reload.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @param deps  a value that changes when a card may have moved — a SIGNATURE
 *              string, not an array, whose identity changes on every render.
 * @param enabled  false parks the animation and clears anything half-run (a
 *              drag ending, a list that must not animate its first paint).
 * @param idAttribute  the attribute carrying each card's stable id.
 * @returns `setHost` for the element containing the cards, and `capture` for a
 *          caller that knows a move is coming.
 */
export function useSlideOnMove(
  deps: unknown,
  enabled: boolean,
  idAttribute: string = DEFAULT_ID_ATTRIBUTE,
): { setHost: (el: HTMLElement | null) => void; capture: () => void } {
  const host = useRef<HTMLElement | null>(null);
  const last = useRef(new Map<string, DOMRect>());

  /** Where every card is at this instant, transforms and all. */
  const measure = useCallback((): Map<string, DOMRect> => {
    const el = host.current;
    const now = new Map<string, DOMRect>();
    if (!el) return now;
    for (const card of el.querySelectorAll<HTMLElement>(`[${idAttribute}]`)) {
      const id = card.getAttribute(idAttribute);
      if (id) now.set(id, card.getBoundingClientRect());
    }
    return now;
  }, [idAttribute]);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduced = prefersReducedMotion();
    const cards = [...el.querySelectorAll<HTMLElement>(`[${idAttribute}]`)];
    const now = new Map<string, DOMRect>();
    for (const card of cards) {
      const id = card.getAttribute(idAttribute);
      if (!id) continue;
      const rect = card.getBoundingClientRect();
      now.set(id, rect);
      const before = last.current.get(id);
      // Positions are still recorded when motion is off — turning the setting
      // back on mid-session must not animate from a stale measurement.
      if (!enabled || reduced || !before) continue;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      card.style.transition = "none";
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      // Two frames: one to let the browser take the inverted position as the
      // start, one to release it. A single frame is sometimes coalesced with the
      // style write above, and the card jumps anyway.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          card.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
          card.style.transform = "";
        });
      });
    }
    last.current = now;
  }, [deps, enabled, idAttribute]);

  // Nothing half-animated survives the end of a drag.
  useEffect(() => {
    if (enabled) return;
    const el = host.current;
    if (!el) return;
    for (const card of el.querySelectorAll<HTMLElement>(`[${idAttribute}]`)) {
      card.style.transition = "";
      card.style.transform = "";
    }
  }, [enabled, idAttribute]);

  // A setter rather than the ref itself: a caller often also hands its element
  // somewhere else, and assigning to a hook's ref from outside it is exactly
  // what the immutability rule is there to stop.
  const setHost = useCallback((el: HTMLElement | null) => {
    host.current = el;
  }, []);

  /**
   * Re-measure now, because a move is about to be asked for.
   *
   * The cached positions are only refreshed when `deps` changes, and plenty of
   * things move a card without touching them — opening a card's own disclosure
   * pushes everything below it down. A caller that KNOWS a move is coming (a
   * switch was just flicked) calls this first, and the slide then starts from
   * where the cards actually are rather than from wherever they were the last
   * time the list itself changed shape.
   */
  const capture = useCallback(() => {
    last.current = measure();
  }, [measure]);

  return { setHost, capture };
}
