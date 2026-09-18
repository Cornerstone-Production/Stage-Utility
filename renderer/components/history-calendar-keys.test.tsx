// Rendering the History calendar must not warn about keys.
//
// `key={dateStr}` sat on the inner <button> while the element the day cell's
// `.map` returned was the <Tooltip> around it, so React saw a whole month of
// unkeyed children: every visit to History logged "Encountered two children with
// the same key" and React was free to reuse the wrong day's DOM on a re-render.
//
// The grid renders either way, so a cell count would not go red on the bug — the
// warning is the assertion that proves the fix. jsx-map-key-placement.test.ts is
// the repo-wide half of the same guard.
//
// NOT unit-tested here, and checked in a real browser instead: the heatmap tint
// (a color-mix() on a CSS custom property — jsdom loads no stylesheet and
// resolves no var()), and the tooltip's own appearance on hover.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its message, and inspecting a live jsdom element does not
// terminate in any useful time.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { installRenderDom } from "../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { HistoryCalendar } = await import("./history-calendar.js");
// Each day cell is a Tooltip, and Radix's throws without a provider. The
// operator app wraps everything in one (renderer/app/index.tsx).
const { TooltipProvider } = await import("./ui/tooltip-provider.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

/** Two recorded days in the month the calendar opens on. */
function monthWithServices(): { counts: Map<string, number>; selected: string } {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { counts: new Map([[`${ym}-07`, 2], [`${ym}-14`, 1]]), selected: `${ym}-07` };
}

test("a month of day cells renders with no duplicate-key warning", () => {
  const { counts, selected } = monthWithServices();
  const errors: string[] = [];
  const before = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const r = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HistoryCalendar, { counts, selected, onPick: () => {} }),
      ),
    );
    // The grid is on screen: a warning-free render of nothing proves nothing.
    assert.ok(screen.queryAllByText("14").length >= 1, "the month grid did not render its days");
    assert.deepEqual(
      errors.filter((e) => e.includes("same key") || e.includes("unique \"key\"")),
      [],
      "the day cells carry their key on a child of the element the map returns",
    );
    r.unmount();
  } finally {
    console.error = before;
  }
});
