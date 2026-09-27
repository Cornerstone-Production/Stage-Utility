// rebuild-button-test-helpers.ts — the two things every test driving a
// "Rebuild from raw" button through a real render needs, shared rather than
// copied. header.test.tsx, header-live-e2e.test.tsx, timer-card.test.tsx and
// baptism-operator-sessions-load.test.tsx each carried their own copy of one
// or both of these — four ways for the button's own text, or the tooltip
// technique, to drift apart.
//
// TEST-ONLY: no `.test.` in the filename on purpose, so `npm test`'s glob does
// not pick this up as a (zero-test) suite of its own.

import { act, fireEvent } from "@testing-library/react";

import { settle } from "../../../test-dom.js";

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * Every "Rebuild from raw" button under `root`. `scope` narrows which ones:
 * the header's own single action-group button sits directly under whatever
 * root a test rendered into, while the save-failure note's per-entry buttons
 * each live inside their own `[role="alert"]` — and a service can fail more
 * than one session at once, so that caller needs every match, not just the
 * first. Callers wanting exactly one index `[0]`, same as `.find()` would
 * have handed them.
 */
export function rebuildButtonsIn(root: ParentNode, scope = "button"): HTMLButtonElement[] {
  return [...root.querySelectorAll(scope)].filter((b) =>
    (b.textContent ?? "").includes("Rebuild from raw"),
  ) as HTMLButtonElement[];
}

/**
 * Opens `btn`'s own tooltip via keyboard focus (Radix's Tooltip opens on
 * hover AND focus too) and reads its rendered text, then closes it again.
 * Works even on a DISABLED button — jsdom does not enforce a real browser's
 * "a disabled element cannot receive focus," which is exactly what makes
 * this usable for reading a disabled Rebuild button's own reason.
 */
export async function tooltipTextOf(btn: HTMLElement): Promise<string> {
  fireEvent.focus(btn);
  await act(async () => {
    await settle();
    await settle();
  });
  const shown = text(document.querySelector('[role="tooltip"]'));
  fireEvent.blur(btn);
  await act(async () => {
    await settle();
  });
  return shown;
}
