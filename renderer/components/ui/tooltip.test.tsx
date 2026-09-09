// A tooltip is deliberately hover/focus-only for a mouse — see tooltip.tsx's
// own comment — but that leaves a coarse pointer (a finger) with no way to
// open one at all, since it has no hover. This file is the guard for the tap
// path added for that: a tap on the trigger opens it AND still reaches the
// trigger's own click, and the next tap anywhere else closes it again.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, mock, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, screen, waitFor } = await import("@testing-library/react");
const { Tooltip } = await import("./tooltip.js");
const { TooltipProvider } = await import("./tooltip-provider.js");

after(() => {
  cleanup();
  teardown();
});

/** Stub `matchMedia` so `useCoarsePointer` answers a fixed value for every
 *  query — the same shape expand-overlay.test.tsx uses for reduced-motion. */
function stubPointer(coarse: boolean) {
  const real = window.matchMedia;
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("pointer: coarse") ? coarse : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  return () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = real;
  };
}

// pointerdown, pointerup, THEN click — jsdom does not synthesize the click a
// real touchscreen would from the first two, so a test that only fires
// pointerdown/up never exercises the path that actually broke: Radix's own
// Trigger closes an open tooltip on ANY click (see tooltip.tsx's comment), so
// a tap that stopped at pointerup passed against a bug a real tap would hit
// the moment its own click landed.
function tap(el: Element) {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch" });
  fireEvent.pointerUp(el, { pointerId: 1, pointerType: "touch" });
  fireEvent.click(el);
}

describe("Tooltip — coarse pointer", () => {
  afterEach(() => cleanup());

  test("a tap on the trigger opens it, and its own click still fires", async () => {
    const restore = stubPointer(true);
    const onClick = mock.fn();
    try {
      render(
        <TooltipProvider>
          <Tooltip label="Send to back">
            <button type="button" onClick={onClick}>
              Icon
            </button>
          </Tooltip>
        </TooltipProvider>,
      );
      const trigger = screen.getByText("Icon");
      tap(trigger);

      await waitFor(() => assert.ok(screen.getByText("Send to back"), "tooltip did not open on tap"));
      assert.equal(onClick.mock.callCount(), 1, "the trigger's own click must still fire");
    } finally {
      restore();
    }
  });

  test("a second tap outside the trigger closes it", async () => {
    const restore = stubPointer(true);
    try {
      render(
        <TooltipProvider>
          <Tooltip label="Send to back">
            <button type="button">Icon</button>
          </Tooltip>
        </TooltipProvider>,
      );
      const trigger = screen.getByText("Icon");
      tap(trigger);
      await waitFor(() => assert.ok(screen.getByText("Send to back")));

      fireEvent.pointerDown(document.body, { pointerId: 2, pointerType: "touch" });

      await waitFor(() => assert.equal(screen.queryByText("Send to back"), null, "a tap outside must close it"));
    } finally {
      restore();
    }
  });

  test("tapping the trigger again closes it too", async () => {
    const restore = stubPointer(true);
    try {
      render(
        <TooltipProvider>
          <Tooltip label="Send to back">
            <button type="button">Icon</button>
          </Tooltip>
        </TooltipProvider>,
      );
      const trigger = screen.getByText("Icon");
      tap(trigger);
      await waitFor(() => assert.ok(screen.getByText("Send to back")));
      tap(trigger);
      await waitFor(() => assert.equal(screen.queryByText("Send to back"), null));
    } finally {
      restore();
    }
  });

  test("a mouse trigger is unaffected: no tap-toggle wrapper, hover behaviour intact", () => {
    const restore = stubPointer(false);
    try {
      render(
        <TooltipProvider>
          <Tooltip label="Send to back">
            <button type="button">Icon</button>
          </Tooltip>
        </TooltipProvider>,
      );
      const trigger = screen.getByText("Icon");
      // No coarse-only wrapper span: the trigger's parent is whatever Radix's
      // Trigger renders onto the child directly (asChild), not an extra
      // `inline-flex` span this file's own coarse path introduces.
      assert.notEqual(trigger.parentElement?.className, "inline-flex");
    } finally {
      restore();
    }
  });
});
