// The History calendar's shade is the number of services that day.
//
// It used to be an attendance HEATMAP: a day's tint came from its peak in-room
// count normalised against the busiest day ever recorded. Two days with one
// service each shaded differently, and a Sunday with three services could read
// LIGHTER than a quiet midweek one. The shade now says one thing — how many
// services — in four steps.
//
// WHAT IS NOT ASSERTED HERE, AND WHY. The tint itself is a `color-mix()` on a
// CSS custom property; jsdom loads no stylesheet and resolves no `var()`, so
// `getComputedStyle` reports the literal string back and a colour assertion
// would prove nothing about what is on screen. `data-shade` is the number the
// style is BUILT from, which is the part that can be wrong. The accent outline
// on today and the accent ring on the selected day are Tailwind ring utilities
// — also stylesheet — and were checked in Chrome at 1280 and 600, light and
// dark.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { installRenderDom } from "../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { HistoryCalendar, shadeStep } = await import("./history-calendar.js");
const { TooltipProvider } = await import("./ui/tooltip-provider.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

test("a day's shade step follows its service count", () => {
  // One line per case, so two branches adding different cases merge cleanly.
  assert.deepEqual(
    [0, 1, 2, 3, 6].map((n) => [n, shadeStep(n)]),
    [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      // Everything at or above four is the darkest step. Six services is not a
      // seventh shade nobody could tell from the fourth.
      [6, 4],
    ],
  );
});

/** The month the calendar opens on, with a count on the 7th. */
function monthWith(count: number): { counts: Map<string, number>; day: string } {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const day = `${ym}-07`;
  return { counts: new Map([[day, count]]), day };
}

function renderMonth(count: number) {
  const { counts, day } = monthWith(count);
  const r = render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(HistoryCalendar, { counts, selected: day, onPick: () => {} }),
    ),
  );
  const cells = [...r.container.querySelectorAll<HTMLElement>("button[data-shade]")];
  // Found by DATE, not by its text: the text is what one of the tests below is
  // asserting, and a helper that located the cell by reading it could never see
  // that cell print anything extra.
  const seventh = cells.find((c) => c.getAttribute("data-date") === day);
  assert.ok(seventh, "the 7th did not render");
  return { r, seventh, cells };
}

test("the drawn cell carries the step its count maps to", () => {
  for (const [count, step] of [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [6, "4"]] as const) {
    const { r, seventh } = renderMonth(count);
    assert.equal(
      seventh.getAttribute("data-shade"),
      step,
      `a day with ${count} services must draw shade step ${step}`,
    );
    r.unmount();
  }
});

test("a day cell prints its day number and nothing else", () => {
  // The count is carried by the shade alone: no dot, no numeral. A cell that
  // printed "3" under the 7 is the thing this forbids — and an accessible name
  // is where the count belongs instead, for anyone who cannot see a tint.
  const { r, cells, seventh } = renderMonth(3);
  assert.equal(seventh.textContent?.trim(), "7", "the cell must carry the day number alone");
  assert.equal(seventh.getAttribute("aria-label"), "3 services");
  // Every OTHER cell in the grid is a bare day number too — a stray count
  // rendered into one cell would not be caught by looking only at the 7th.
  const offenders = cells
    .map((c) => (c.textContent ?? "").trim())
    .filter((t) => !/^\d{1,2}$/.test(t));
  assert.deepEqual(offenders, [], "a day cell rendered something that is not its day number");
  r.unmount();
});

test("the shade is green, and the accent is left to mean 'this is the day you picked'", () => {
  // The accent rings TODAY and the SELECTED day on this same grid. Shading the
  // fill with it too gave one colour two meanings a cell apart. Asserted on the
  // inline style the component PUT on the element — a token named anywhere else
  // in the file cannot satisfy it.
  const { r, seventh, cells } = renderMonth(3);
  assert.match(seventh.style.backgroundColor, /--color-green-9/, `the shade is ${seventh.style.backgroundColor}`);
  const accented = cells.filter((c) => c.style.backgroundColor.includes("--color-accent"));
  assert.deepEqual(accented.map((c) => c.getAttribute("data-date")), [], "a cell is FILLED with the accent");
  r.unmount();
});

test("the shade is explained in a sentence, not a row of tints", () => {
  // Four swatches and their numbers under a grid of the same four tints is the
  // same picture twice, and the question a shaded grid raises is what the shade
  // is, not which of four a given cell is. The count is on the tooltip.
  const { r } = renderMonth(3);
  const text = r.container.textContent ?? "";
  assert.ok(text.includes("Shade is how many services ran that day."), `no explanation: ${text}`);
  assert.ok(text.includes("Today is outlined."), "the outline is not explained either");
  assert.ok(!text.includes("4+"), "the old step legend is still there");
  r.unmount();
});
