// Point at the control that actually does the job, after arriving at its page.
//
// Landing on the right page still leaves you hunting for the field, which on a
// dense page like Integrations is most of the work. `flashTarget` names a
// `data-flash-id` somewhere in the destination; once it has rendered, it is
// scrolled into view and outlined briefly. Matching by attribute rather than by
// ref means a section only has to label its target, not export anything.
//
// Lifted from settings-view.tsx's navigateToSection, minus the tab switch —
// that half is now a route change. The rest is unchanged, including two details
// that look skippable and are not:
//
//   - TWO animation frames. One lets React commit the destination, the second
//     lets layout settle so scrollIntoView lands somewhere real. With one, it
//     scrolls to where the element was about to be.
//   - The `void el.offsetWidth` reflow read between removing and adding the
//     class. Without it the browser coalesces both into no change at all, and
//     a second visit to the same target does nothing visible.

/** The class carrying the highlight animation (defined in styles.css). */
export const FLASH_CLASS = "su-flash";

/** How long the highlight stays before it is cleared. */
const FLASH_MS = 2000;

/**
 * Scroll to `[data-flash-id="<flashId>"]` and pulse it.
 *
 * Silent when the target never renders — a destination may legitimately not
 * show the field (an integration that is not configured, say), and throwing
 * there would blank the route the operator just navigated to.
 */
export function flashTarget(flashId: string): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-flash-id="${flashId}"]`);
      if (!el) return;
      // Guarded because the highlight is the more important half: if scrolling
      // is unavailable the operator can still find the outlined field, but an
      // exception here would skip the highlight entirely. Every browser has
      // this; jsdom does not, which is how the gap showed up.
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      el.classList.remove(FLASH_CLASS);
      void el.offsetWidth; // restart the animation if it is already running
      el.classList.add(FLASH_CLASS);
      window.setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
    }),
  );
}
