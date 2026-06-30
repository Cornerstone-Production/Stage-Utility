// Wrap a state update in the View Transitions API for a gentle crossfade between
// settings sections / kiosk views. Progressive enhancement: a no-op (runs the
// update immediately) when the browser lacks startViewTransition or the user
// prefers reduced motion. The default root crossfade is used — unchanged chrome
// (e.g. the sidebar) fades identically, so only the changed content appears to
// transition.
export function withViewTransition(update: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduced || typeof doc.startViewTransition !== "function") {
    update();
    return;
  }
  doc.startViewTransition(update);
}
