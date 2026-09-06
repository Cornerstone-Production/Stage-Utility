// Crossfade a DOM update with the View Transitions API, when the browser has it
// and the user has not asked for reduced motion.
//
// THE UPDATE MUST NOT WAIT FOR THE USER. `document.startViewTransition` freezes
// rendering from the moment it is called until the update callback settles, then
// animates old to new. The rail passed it `() => router.navigate(...)`, whose
// promise does not settle while a navigation blocker is asking "save your
// changes?" — so the page stopped painting with the dialog unpainted, sat that
// way until the browser gave up (`TimeoutError: Transition was aborted because
// of timeout in DOM update`), and the operator saw a frozen console and reached
// for refresh. Reported from a console with unsaved layout edits, 2026-09-06.
//
// So the update's promise is raced against a short cap. A navigation that lands
// within it is crossfaded as before; one that is waiting on a person lets the
// transition end and the dialog paint.

import { prefersReducedMotion } from "./reduced-motion";

/** Longest the transition waits on the update. Long enough for a route change
 *  to commit, far shorter than any human decision. */
export const VIEW_TRANSITION_UPDATE_CAP_MS = 400;

type StartViewTransition = (cb: () => void | Promise<unknown>) => unknown;

export function withViewTransition(update: () => unknown): void {
  const doc = document as Document & { startViewTransition?: StartViewTransition };
  if (prefersReducedMotion() || typeof doc.startViewTransition !== "function") {
    void update();
    return;
  }
  doc.startViewTransition(() => boundedUpdate(update));
}

/**
 * Run `update` and settle no later than the cap, whatever the update returns.
 * Exported so the guard can drive it without a real `startViewTransition`.
 */
export function boundedUpdate(update: () => unknown, capMs = VIEW_TRANSITION_UPDATE_CAP_MS): Promise<void> {
  const result = update();
  if (!(result instanceof Promise)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, capMs);
    result.then(
      () => { clearTimeout(t); resolve(); },
      () => { clearTimeout(t); resolve(); },
    );
  });
}
