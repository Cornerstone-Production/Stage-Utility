// Which square is today is answered on the SERVER's clock, on every surface.
//
// The bug: CalendarView took an optional `nowMs` and fell back to its own
// `Date.now()`. The embedded tile passed `ctx.now + ctx.skewMs` — above a comment
// saying this app has one clock and this question must be asked on it — and the
// DISPLAY route passed nothing at all. So the same view answered from two
// different clocks depending on the surface, and the uncorrected one was the wall
// display: a Pi on an isolated production LAN, where no NTP is normal and a clock
// hours out is ordinary. It highlighted one day next to a tile showing another.
//
// Fixed IN THE COMPONENT rather than at the two call sites, so that the third
// call site cannot be wrong: with no `nowMs` the component subscribes to the same
// `pco:live` the corrected callers derive their skew from.
//
// The browser clock here is moved six days FORWARD of the server's, which is the
// shape that matters — a drift small enough to look plausible and large enough to
// name a different square. Every id and name below is invented.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import type { CalendarGrid } from "@main/types/calendar";

const teardown = installDom();

const ZONE = "America/Chicago";
/** What the server says the time is. Mid-afternoon in the zone, so no rounding
 *  or offset argument can move it across midnight by itself. */
const SERVER_NOW = "2026-08-14T18:00:00.000Z";
/** What this browser thinks it is: six days fast. */
const DRIFTED = Date.parse("2026-08-20T18:00:00.000Z");

/** A six-week grid for August 2026 (26 July - 5 September), holding no events —
 *  this file is about the highlight, not the contents. */
function grid(): CalendarGrid {
  const days = [];
  const start = Date.UTC(2026, 6, 26);
  for (let i = 0; i < 42; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    days.push({ date, inMonth: date.startsWith("2026-08"), events: [] });
  }
  return { monthLabel: "August 2026", days, zone: ZONE, unplaceable: 0 };
}

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const payload = String(url).includes("/api/pco/calendar") ? grid() : {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

/** An EventSource that records its listeners, so a frame can be delivered. */
const sseHandlers = new Map<string, Set<(e: { data: string }) => void>>();
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  addEventListener(channel: string, fn: (e: { data: string }) => void) {
    let set = sseHandlers.get(channel);
    if (!set) sseHandlers.set(channel, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(channel: string, fn: (e: { data: string }) => void) {
    sseHandlers.get(channel)?.delete(fn);
  }
  close() {}
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CalendarView } = await import("./calendar-view.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
const realNow = Date.now;

beforeEach(() => {
  cleanup();
  // The drifted wall Pi. Restored in afterEach — a leaked clock would make every
  // file that runs after this one behave differently depending on the order.
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

/** Deliver one frame on a channel, exactly as the server's fan-out would. */
function push(channel: string, payload: unknown): void {
  for (const fn of sseHandlers.get(channel) ?? []) fn({ data: JSON.stringify(payload) });
}

/** The date of the square marked today, or null when none is. */
function markedToday(): string | null {
  const marked = document.querySelectorAll('[aria-current="date"]');
  assert.ok(marked.length <= 1, `${marked.length} squares are marked today`);
  return (marked[0] as HTMLElement | undefined)?.dataset.date ?? null;
}

describe("the calendar on a display asks the server what day it is", () => {
  test("the browser clock alone would mark the wrong square", () => {
    // The control. Without it the assertion below could pass on a component that
    // ignores the clock entirely, and both readings would look like success.
    assert.notEqual(
      new Date(DRIFTED).toISOString().slice(0, 10),
      SERVER_NOW.slice(0, 10),
      "the fixture clocks agree — this file would prove nothing",
    );
  });

  test("THE GUARD: with no nowMs prop, the server's day is the one marked", async () => {
    await act(async () => {
      render(
        React.createElement(CalendarView, {
          viewId: "view-cal",
          pcoConfigured: true,
          interactive: false,
          // No nowMs. This is the DISPLAY route's call, which is the surface the
          // bug was on.
        } as never),
      );
      await settle();
    });
    await act(async () => {
      push("calendar:grid", { viewId: "view-cal", grid: grid() });
      push("pco:live", { serverNow: SERVER_NOW });
      await settle();
    });

    // Restore `Date.now` before asserting: the fallback the fix replaced would
    // mark 2026-08-20 here, and that is the whole difference.
    assert.equal(
      markedToday(),
      "2026-08-14",
      "the calendar marked today from the browser's own clock — a display whose clock has drifted highlights the wrong day",
    );
  });
});
