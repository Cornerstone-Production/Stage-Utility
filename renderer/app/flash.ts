import { useEffect, useRef, useState } from "react";

// Point at the control that actually does the job, after arriving at its page.
//
// Landing on the right page still leaves you hunting for the field, which on a
// dense page like Integrations is most of the work. `flashTarget` names a
// `data-flash-id` somewhere in the destination; once it has rendered, it is
// scrolled into view and outlined briefly. Matching by attribute rather than by
// ref means a section only has to label its target, not export anything.
//
// Lifted from settings-view.tsx's navigateToSection, minus the tab switch —
// that half is now a route change. Two details from the original look skippable
// and are not:
//
//   - waiting for animation frames. The destination has not rendered when
//     navigation starts, so querying immediately finds nothing.
//   - the `void el.offsetWidth` reflow read between removing and adding the
//     class. Without it the browser coalesces both into no change at all, and a
//     second visit to the same target does nothing visible.
//
// What is new: the reveal signal. A target can be inside a collapsed section —
// Integrations auto-collapses everything unconfigured into "Not set up", which
// is exactly the state a first-run operator is in, so Getting Started's first
// step pointed at an element that was not in the DOM at all. Rather than
// teaching this module about integrations, it announces what it is looking for
// and any collapsed surface can open itself.

/** The class carrying the highlight animation (defined in styles.css). */
export const FLASH_CLASS = "su-flash";

/** How long the highlight stays before it is cleared. */
const FLASH_MS = 2000;

/** How long to keep looking for a target that may still be revealing itself. */
const FIND_TIMEOUT_MS = 1200;

/**
 * Fired before the search begins. Anything that can hide a flash target listens
 * and reveals it — see the "Not set up" group in integrations-panel.tsx.
 */
export const REVEAL_EVENT = "stage:reveal-flash-target";

export interface RevealDetail {
  flashId: string;
}

/**
 * What is currently being looked for, if anything.
 *
 * The event alone is not enough: flashTarget is called from the page you are
 * LEAVING, so the destination's listeners do not exist yet when it fires. A
 * component that can hide a target therefore checks this on mount as well as
 * listening — the event covers "already mounted", this covers "mounted after".
 */
let pending: string | null = null;

export function pendingFlashTarget(): string | null {
  return pending;
}

function find(flashId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-flash-id="${flashId}"]`);
}

function highlight(el: HTMLElement): void {
  // Guarded because the highlight is the more important half: if scrolling is
  // unavailable the operator can still find the outlined field, but an
  // exception here would skip the highlight entirely. Every browser has this;
  // jsdom does not, which is how the gap showed up.
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  el.classList.remove(FLASH_CLASS);
  void el.offsetWidth; // restart the animation if it is already running
  el.classList.add(FLASH_CLASS);
  window.setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
}

/**
 * Scroll to `[data-flash-id="<flashId>"]` and pulse it, revealing it first if
 * something is hiding it.
 *
 * Gives up quietly after FIND_TIMEOUT_MS. A destination may legitimately never
 * show the field, and throwing there would blank the route the operator just
 * navigated to.
 */
export function flashTarget(flashId: string): void {
  pending = flashId;
  window.dispatchEvent(
    new CustomEvent<RevealDetail>(REVEAL_EVENT, { detail: { flashId } }),
  );

  const deadline = Date.now() + FIND_TIMEOUT_MS;
  const attempt = () => {
    const el = find(flashId);
    if (el) {
      pending = null;
      highlight(el);
      return;
    }
    if (Date.now() < deadline) {
      // Keep looking: the route is still rendering, or a section is mid-reveal.
      requestAnimationFrame(attempt);
    } else {
      // Give up quietly. Leaving `pending` set would make the next mount of any
      // listener reveal something nobody asked for.
      pending = null;
    }
  };
  // Two frames before the first look, as the original did: one for React to
  // commit, one for layout to settle so scrollIntoView lands somewhere real.
  requestAnimationFrame(() => requestAnimationFrame(attempt));
}

/**
 * A counter that ticks whenever a flash target THIS surface can reveal is
 * requested.
 *
 * Use it as a `key` to remount a collapsed thing with `defaultOpen`, which is
 * why it is a nonce rather than a boolean: remounting lets the operator close
 * the thing again afterwards, and it avoids a setState inside an effect.
 *
 * Seeded from the pending target because `flashTarget` runs on the page being
 * LEFT — its event fires before the destination has mounted. The listener covers
 * the other order, when the surface is already on screen.
 *
 * Extracted from IntegrationsPanel, which had the only copy, when the
 * integration ROWS needed exactly the same behaviour: a configured integration
 * is collapsed, so the card a highlight is aimed at is not in the DOM at all.
 */
export function useRevealNonce(matches: (flashId: string) => boolean): number {
  // Held in a ref so the listener is subscribed once and still sees the newest
  // predicate — `matches` is a fresh closure on every render.
  const matchRef = useRef(matches);
  useEffect(() => {
    matchRef.current = matches;
  });
  const [nonce, setNonce] = useState(() => {
    const pending = pendingFlashTarget();
    return pending && matches(pending) ? 1 : 0;
  });
  useEffect(() => {
    const onReveal = (e: Event) => {
      const flashId = (e as CustomEvent<RevealDetail>).detail?.flashId;
      if (flashId && matchRef.current(flashId)) setNonce((n) => n + 1);
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, []);
  return nonce;
}
