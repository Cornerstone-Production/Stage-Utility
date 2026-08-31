// dialog-focus.ts — the two halves of "a dialog owns the keyboard while it is up".
//
// ONE COPY. The app opens three of these — the expanded-tile overlay, the colour
// panel and the console rail's icon menu — and each is a portal on document.body
// with a role="dialog" on it. expand-overlay.tsx got the behaviour right first;
// the other two had none of it, and writing it out again in each of them is this
// repository's most expensive recurring mistake in miniature. So it lives here
// and all three call it.
//
// WHAT IS NOT HERE: which element takes focus when the dialog opens. That
// genuinely differs — the overlay focuses its close button, the colour panel
// focuses the panel itself because it has no close control, and the icon menu's
// grid focuses its own search field, because typing is how a set that size is
// used. Each of those is one line where it belongs.

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** Everything a Tab can land on inside a panel. */
export const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Tab cycles within `panel` instead of walking out the back of it.
 *
 * A portalled panel is rendered at the END of document.body, so without this a
 * Tab from the last control inside goes to the browser chrome and a Shift+Tab
 * from the first walks the whole page BEHIND the dialog — every control the
 * dialog is covering, in order, with nothing on screen to show where focus is.
 *
 * Call it from a keydown handler on the panel root: a keydown only reaches that
 * node when focus is already inside, so there is no "focus is outside" case to
 * handle.
 */
export function trapTab(panel: HTMLElement | null, e: ReactKeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  if (!panel) return;
  const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  // FOCUS ON THE PANEL ITSELF steps into the list, from whichever end the key
  // is heading. A dialog with no obvious first control takes focus on its own
  // container (tabIndex -1) when it opens — the colour panel does — and that
  // container is deliberately NOT in `focusable`, so it is neither `first` nor
  // `last` and the two cases below both miss it. The browser then does its
  // default thing: a portal is rendered at the end of <body>, so Shift+Tab
  // walked backwards into the page the dialog is covering. Measured in Chrome,
  // where Shift+Tab off the open colour panel landed on "Refresh all" behind
  // it; jsdom simulates no default Tab movement, so it saw nothing wrong.
  if (active === null || !focusable.includes(active as HTMLElement)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }

  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Focus goes back where it came from when the dialog closes.
 *
 * Without it focus falls to <body> — the control that opened the dialog is
 * usually inside it or unmounted by it — and the operator's next Tab starts at
 * the top of the page rather than where they were.
 *
 * @param open whether the dialog is up.
 * @param target called at the MOMENT OF CLOSING to find the node to focus.
 *   A getter, not a node, and that is the whole point: the trigger may have been
 *   replaced since the dialog opened. Picking a new icon rebuilds the very glyph
 *   the menu was anchored to, and a saved colour can re-render the card its
 *   swatch sits on — so a held reference is a detached node, and focusing one
 *   silently does nothing. Look the element up fresh (by id, or off a ref that
 *   is checked with isConnected) and return null when it is genuinely gone.
 *
 * Written as one effect on both edges rather than an effect with a cleanup: the
 * node to return to is the one on the page WHEN THE DIALOG CLOSES, and a cleanup
 * that reads a ref at that moment is the pattern the exhaustive-deps rule
 * (correctly, in general) warns about.
 */
export function useReturnFocus(open: boolean, target: () => HTMLElement | null): void {
  const wasOpen = useRef(false);
  // The getter is re-created on every render by every caller. Held in a ref so
  // the effect below depends on `open` alone — a dependency on the function
  // itself would run it on every render and return focus while the dialog is
  // still up.
  const latest = useRef(target);
  // Refreshed in an effect, not during render — a ref written while rendering is
  // exactly what react-hooks/refs forbids, and the rule is right. Declared
  // BEFORE the effect below so that on the commit where `open` goes false,
  // effects run in declaration order and this one has already put the current
  // render's getter in place.
  useEffect(() => {
    latest.current = target;
  });
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    latest.current()?.focus();
  }, [open]);
}
