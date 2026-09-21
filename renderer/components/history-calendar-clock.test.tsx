// Which square History's calendar rings as today is answered on the SERVER's
// clock, in the APP's zone, exactly as the Planning Center calendar's is.
//
// Two separate bugs have lived here, and this file guards both:
//
// - The INSTANT was wrong: a console whose clock has drifted used to ring a day
//   that is not today. Fixed by reading `serverClock.now()` instead of
//   `Date.now()`, and it was missed by a sweep that looked for `Date.now()` —
//   this one said `new Date()`.
// - The CALENDAR FIELDS were wrong, even once the instant was right:
//   `getFullYear`/`getMonth`/`getDate` read the RUNTIME's own zone, not the
//   app's. Reproduced on a real server with a correct, synced clock and only
//   the browser's zone set to Pacific/Auckland against a server on
//   America/Chicago: the calendar rang 2026-09-22 while the server's day was
//   2026-09-21, with no clock skew involved at all. Fixed by reading the `zone`
//   prop through `zonedParts`/`zonedDateKey` (main/services/app-timezone.ts),
//   the same helper Trends and the PCO calendar already read theirs through.
//
// Everything this is compared against comes from the server: the recorded
// service days it shades, and the month it will not page past.
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

describe("History's calendar rings the day in the APP's zone, not this runtime's own", () => {
  /**
   * One instant, two zones that disagree about what day it is — with no clock
   * skew anywhere in this block; `serverClock` is given the true instant both
   * times. Chosen to reproduce the field report exactly: a server on
   * America/Chicago at 2026-09-21 20:00 local, read from a console set to
   * Pacific/Auckland, where the same instant is already 2026-09-22 13:00.
   */
  const INSTANT = Date.parse("2026-09-22T01:00:00.000Z");
  const CHICAGO_DAY = "2026-09-21";
  const AUCKLAND_DAY = "2026-09-22";

  test("the two fixture zones disagree, so this file proves something", () => {
    assert.notEqual(CHICAGO_DAY, AUCKLAND_DAY);
  });

  /**
   * Renders the SAME instant under each zone in turn. On the buggy code the
   * `zone` prop does not exist, so both renders would ring whatever day this
   * test runner's own environment zone reads at INSTANT — a single fixed
   * value that cannot equal both CHICAGO_DAY and AUCKLAND_DAY, since they are
   * different strings. So at least one of these two assertions goes red on
   * the bug regardless of which zone the runner itself happens to be in.
   */
  async function ringedFor(zone: string): Promise<string | null> {
    serverClock.reset();
    serverClock.observe(INSTANT, 0);
    let container!: HTMLElement;
    await act(async () => {
      const view = render(
        React.createElement(HistoryCalendar, {
          counts: new Map<string, number>(),
          selected: null,
          onPick: () => {},
          zone,
        } as never),
      );
      container = view.container;
      await settle();
    });
    return ringedToday(container);
  }

  test("THE GUARD: America/Chicago rings its own day at this instant", async () => {
    assert.equal(await ringedFor("America/Chicago"), CHICAGO_DAY);
  });

  test("THE GUARD: Pacific/Auckland rings its own, later day at the SAME instant", async () => {
    assert.equal(await ringedFor("Pacific/Auckland"), AUCKLAND_DAY);
  });
});
