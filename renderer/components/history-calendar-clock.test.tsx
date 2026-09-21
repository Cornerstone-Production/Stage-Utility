// Which square History's calendar rings as today is answered on the SERVER's
// clock, exactly as the Planning Center calendar's is.
//
// This is the same reading calendar-clock.test.tsx guards one component over,
// and it was missed by a sweep that looked for `Date.now()` — this one said
// `new Date()`. Everything it is compared against comes from the server: the
// recorded service days it shades, and the month it will not page past. A
// console whose clock has drifted rings a day that is not today and refuses
// months that exist.
//
// The clock is read once, at mount, and deliberately not ticked: a calendar that
// repaints because midnight passed under a stationary cursor is not worth a
// re-render, and nothing here changes within a day.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** What the server says the day is. Mid-afternoon, so no zone offset can move it
 *  across midnight by itself. */
const SERVER_NOW = Date.parse("2026-08-14T18:00:00.000Z");
/** What this console thinks: six days fast — plausible enough to look right, far
 *  enough to name a different square. */
const DRIFTED = Date.parse("2026-08-20T18:00:00.000Z");

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { HistoryCalendar } = await import("./history-calendar.js");
const { serverClock } = await import("../lib/server-clock.js");

const realNow = Date.now;
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The local day a given instant falls on, in this host's zone — which is what
 *  the component builds its grid in. */
const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

beforeEach(() => {
  cleanup();
  serverClock.reset();
  Date.now = () => DRIFTED;
});
afterEach(async () => {
  Date.now = realNow;
  cleanup();
  await settle();
});
after(async () => {
  Date.now = realNow;
  await settle();
  teardown();
});

function ringedToday(container: HTMLElement): string | null {
  const cells = container.querySelectorAll("[data-today]");
  assert.ok(cells.length <= 1, `${cells.length} squares are ringed as today`);
  return (cells[0] as HTMLElement | undefined)?.dataset.date ?? null;
}

describe("History's calendar rings the server's today", () => {
  test("the two clocks name different days, so this file proves something", () => {
    assert.notEqual(dayOf(SERVER_NOW), dayOf(DRIFTED), "the fixture clocks agree — this file would prove nothing");
  });

  test("THE GUARD: the ringed square is the server's day, not this console's", async () => {
    // Set before mount, which is the real case: the shell has been up and the
    // clock has had a reading long before anyone opens History.
    serverClock.observe(SERVER_NOW, 20);
    let container!: HTMLElement;
    await act(async () => {
      const view = render(
        React.createElement(HistoryCalendar, {
          counts: new Map<string, number>(),
          selected: null,
          onPick: () => {},
        } as never),
      );
      container = view.container;
      await settle();
    });
    assert.equal(
      ringedToday(container),
      dayOf(SERVER_NOW),
      `the calendar ringed today from this console's own clock (${dayOf(DRIFTED)}), which is six days out`,
    );
  });

  test("with no reading yet it falls back to the host clock, which is all there is", async () => {
    let container!: HTMLElement;
    await act(async () => {
      const view = render(
        React.createElement(HistoryCalendar, {
          counts: new Map<string, number>(),
          selected: null,
          onPick: () => {},
        } as never),
      );
      container = view.container;
      await settle();
    });
    assert.equal(ringedToday(container), dayOf(DRIFTED));
  });
});
