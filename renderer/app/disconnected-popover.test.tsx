// The "N disconnected" panel has to escape the bar it hangs from.
//
// Reported from a browser: the panel was sliced off a few pixels below its
// trigger, and the rows that WERE visible could not be clicked. One cause for
// both. The context bar scrolls sideways from sm up, and `overflow-x: auto`
// computes `overflow-y` to `auto` too — so an absolutely positioned child was
// clipped to the bar's 44px height, and everything past that fell outside the
// hit-test region as well as out of sight.
//
// jsdom has no layout engine, so this cannot measure the clipping that made the
// bug visible; that was verified in a browser (panel 39-214px inside a bar
// ending at 44px, all three rows unreachable by elementFromPoint, then all three
// reachable after the fix). What it CAN do is render the real component and
// check the thing the fix turns on — that the panel is positioned against the
// viewport rather than against its scrolling ancestor — and that dismissing
// still works, since the panel moved.
//
// A guard for "a press on a row does not dismiss the panel" was written and then
// deleted: the panel is still a DOM child of the trigger's wrapper, so the
// existing `contains` check covers it and the test passed with the check
// removed. A test that cannot fail is worse than no test.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { DisconnectedPopover } = await import("./disconnected-popover.js");

// Unconditional, not a call at the end of each test body: a test that FAILS
// never reaches its own cleanup, so the next render finds two of everything and
// fails for a reason that has nothing to do with what it guards. Proving these
// guards against the bug is exactly when tests fail on purpose.
afterEach(() => cleanup());

after(() => {
  teardown();
});

const DOWN = [
  { id: "obs", connection: "error", message: "OBS connection dropped" },
  { id: "reaper", connection: "disconnected", message: null },
] as never;

const LABELS = { obs: "OBS Studio", reaper: "REAPER" };

/** Render it and open the panel, the way an operator does. */
function open() {
  const view = render(<DisconnectedPopover down={DOWN} labels={LABELS} />);
  fireEvent.click(view.getByRole("button", { name: /disconnected/ }));
  return view;
}

describe("the disconnected panel escapes the context bar", () => {
  test("it is positioned against the viewport, not its scrolling ancestor", () => {
    const view = open();
    const panel = view.getByRole("menu");
    const classes = panel.className.split(/\s+/);
    // `absolute` resolves against the nearest positioned ancestor, which is
    // inside the bar's overflow — that is the bug. `fixed` resolves against the
    // viewport, which is outside it.
    assert.ok(classes.includes("fixed"), `panel is not fixed: "${panel.className}"`);
    assert.ok(!classes.includes("absolute"), "panel is absolute, so the bar clips it again");
  });

  test("it has a ground of its own, not an overlay meant to sit on one", () => {
    // `surface-raised` is a 5.5% white overlay in dark mode — correct for a box
    // lifted off a surface it already sits on, and 94.5% transparent for a panel
    // floating over arbitrary content. The pencil button and the card text
    // behind it read straight through. `popover` is the ground every other
    // floating panel uses; measured in a browser it comes out byte-identical to
    // ContextMenu's, in both themes.
    const view = open();
    const cls = view.getByRole("menu").className;
    assert.ok(cls.includes("bg-popover"), `panel has no popover ground: "${cls}"`);
    assert.ok(!cls.includes("bg-surface-raised"), "panel is using the see-through overlay again");
  });

  test("pressing outside still dismisses it", () => {
    // The other half: a panel you can only close from its own trigger gets left
    // open over the thing you were trying to read.
    const view = open();
    assert.ok(view.queryByRole("menu"), "precondition: the panel is open");
    fireEvent.mouseDown(document.body);
    assert.equal(view.queryByRole("menu"), null, "the panel stayed open");
  });
});
