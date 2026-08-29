// What this file guards, and why each one is here.
//
// 1. THE OVERFLOW COUNT IS THE REAL ONE. A busy day does not fit, and a "+3 more"
//    on a day with six hidden is a lie in a smaller font. The count is asserted,
//    not merely its presence.
//
// 2. EXACTLY ONE EVENT IS HIGHLIGHTED AS RUNNING. Overlapping bookings are
//    normal here — a room, a van and the meeting that reserved both. Two
//    highlights read as a bug, and highlighting an all-day marker every day of
//    its run drowns the signal entirely.
//
// 3. A TAG COLOUR STAYS VISIBLE. The colours come from the org's own Calendar
//    and nothing constrains them; the real data contains near-white and
//    near-black. A colour with no contrast against the kiosk backdrop is a dot
//    that is not there.
//
// All three were proven red in the session that wrote them: the overflow count
// was hardcoded, the current-event highlight was removed, and the contrast floor
// was bypassed.
//
// Every id, name and colour below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import type { CalendarEventDTO, CalendarGrid } from "@main/types/calendar";

const teardown = installDom();

// Nothing here fetches — CalendarMonth is handed its grid — but a stub keeps a
// stray call from settling after teardown and failing the whole FILE while every
// test in it passes.
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "{}",
});

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, screen, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CalendarMonth, readableTagColor, visibleEvents, KIOSK_BACKDROP } = await import("./calendar-view.js");
const { contrastRatio } = await import("../components/ui/color-math.js");

const ZONE = "America/Chicago";

function event(
  id: string,
  startsAt: string,
  endsAt: string,
  extra: Partial<CalendarEventDTO> = {},
): CalendarEventDTO {
  return {
    id,
    name: `Event ${id}`,
    startsAt,
    endsAt,
    allDay: false,
    location: null,
    churchCenterUrl: null,
    tags: [],
    ...extra,
  };
}

/** A six-week grid for August 2026 (26 July - 5 September), events on request. */
function grid(byDate: Record<string, CalendarEventDTO[]> = {}): CalendarGrid {
  const days = [];
  const start = Date.UTC(2026, 6, 26);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start + i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    days.push({ date, inMonth: date.startsWith("2026-08"), events: byDate[date] ?? [] });
  }
  return { monthLabel: "August 2026", days, zone: ZONE, unplaceable: 0 };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  await settle();
  teardown();
});
beforeEach(() => cleanup());
afterEach(async () => {
  cleanup();
  await settle();
});

function cell(date: string): HTMLElement {
  const el = document.querySelector(`[data-date="${date}"]`);
  assert.ok(el, `no square for ${date}`);
  return el as HTMLElement;
}

describe("the grid draws what it was given", () => {
  test("renders six weeks, so the layout does not jump between months", () => {
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: grid(), nowMs: Date.parse("2026-08-14T18:00:00Z") }));
    assert.equal(screen.getAllByRole("gridcell").length, 42);
    assert.ok(screen.getByText("August 2026"));
  });

  test("puts an event on its bucketed day", () => {
    // The component does no bucketing of its own — that happens on the server,
    // in the app time zone. It must draw the square it was told.
    const g = grid({ "2026-08-14": [event("a", "2026-08-14T19:00:00Z", "2026-08-14T20:00:00Z")] });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: Date.parse("2026-08-10T18:00:00Z") }));
    assert.ok(cell("2026-08-14").textContent?.includes("Event a"));
    assert.ok(!cell("2026-08-15").textContent?.includes("Event a"));
  });

  test("dims the squares belonging to the neighbouring months", () => {
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: grid(), nowMs: Date.parse("2026-08-14T18:00:00Z") }));
    assert.equal(cell("2026-07-26").dataset.inMonth, "false");
    assert.equal(cell("2026-08-01").dataset.inMonth, "true");
  });

  test("marks today", () => {
    // 2026-08-15T02:00:00Z is the 14th at 21:00 in Chicago. Marking the 15th
    // would be the browser's zone answering a question the app's zone owns.
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: grid(), nowMs: Date.parse("2026-08-15T02:00:00Z") }));
    assert.equal(cell("2026-08-14").getAttribute("aria-current"), "date");
    assert.equal(cell("2026-08-15").getAttribute("aria-current"), null);
  });

  test("marks no square at all when today is outside the month shown", () => {
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: grid(), nowMs: Date.parse("2027-01-05T18:00:00Z") }));
    assert.equal(document.querySelectorAll('[aria-current="date"]').length, 0);
  });
});

describe("a day that does not fit", () => {
  test("shows +N more rather than silently clipping a busy day", () => {
    const events = Array.from({ length: 9 }, (_, i) =>
      event(`e${i}`, `2026-08-14T${String(14 + i).padStart(2, "0")}:00:00Z`, "2026-08-14T23:00:00Z"),
    );
    const g = grid({ "2026-08-14": events });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: Date.parse("2026-08-10T18:00:00Z") }));

    const { shown, hidden } = visibleEvents(events);
    assert.equal(shown.length + hidden, 9, "every event is either drawn or counted");
    // The COUNT, not merely the affordance. A "+3 more" over six hidden events
    // is a lie in a smaller font.
    assert.ok(cell("2026-08-14").textContent?.includes(`+${hidden} more`), cell("2026-08-14").textContent ?? "");
    for (const e of shown) assert.ok(cell("2026-08-14").textContent?.includes(e.name), e.name);
  });

  test("never hides exactly one event behind a +1 more", () => {
    // Spending the last row on "+1 more" instead of the event itself tells the
    // operator strictly less in the same space.
    const events = Array.from({ length: 20 }, (_, i) => event(`e${i}`, "2026-08-14T14:00:00Z", "2026-08-14T15:00:00Z"));
    for (let n = 1; n <= 20; n++) {
      const { hidden } = visibleEvents(events.slice(0, n));
      assert.notEqual(hidden, 1, `${n} events produced a "+1 more"`);
    }
  });

  test("draws every event when they all fit", () => {
    const events = [event("a", "2026-08-14T14:00:00Z", "2026-08-14T15:00:00Z")];
    const { shown, hidden } = visibleEvents(events);
    assert.equal(hidden, 0);
    assert.equal(shown.length, 1);
  });
});

describe("what is happening right now", () => {
  const NOW = Date.parse("2026-08-14T19:30:00Z");

  test("HIGHLIGHTS the event happening now", () => {
    const g = grid({ "2026-08-14": [event("live", "2026-08-14T19:00:00Z", "2026-08-14T20:00:00Z")] });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: NOW }));
    const marked = document.querySelectorAll('[aria-current="true"]');
    assert.equal(marked.length, 1);
    assert.ok(marked[0].textContent?.includes("Event live"));
  });

  test("highlights only ONE event when several overlap", () => {
    // A room, a van and the meeting that reserved both all run at once here.
    const g = grid({
      "2026-08-14": [
        event("early", "2026-08-14T18:00:00Z", "2026-08-14T21:00:00Z"),
        event("mid", "2026-08-14T19:00:00Z", "2026-08-14T20:00:00Z"),
        event("late", "2026-08-14T19:15:00Z", "2026-08-14T22:00:00Z"),
      ],
    });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: NOW }));
    assert.equal(document.querySelectorAll('[aria-current="true"]').length, 1);
  });

  test("highlights nothing when nothing is running", () => {
    const g = grid({ "2026-08-14": [event("done", "2026-08-14T14:00:00Z", "2026-08-14T15:00:00Z")] });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: NOW }));
    assert.equal(document.querySelectorAll('[aria-current="true"]').length, 0);
  });

  test("does not call an all-day marker the thing happening now", () => {
    // An all-day event is in progress every minute of its run. Highlighting it
    // would leave the highlight permanently on and say nothing.
    const g = grid({
      "2026-08-14": [event("allday", "2026-08-14T05:00:00Z", "2026-08-15T04:59:59Z", { allDay: true })],
    });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: NOW }));
    assert.equal(document.querySelectorAll('[aria-current="true"]').length, 0);
  });

  test("highlights a multi-day event only on today's square", () => {
    // It is drawn on every square it touches. Marking it on all of them would
    // put four highlights on the grid for one thing that is running.
    const spanning = event("retreat", "2026-08-13T22:00:00Z", "2026-08-16T20:00:00Z");
    const g = grid({
      "2026-08-13": [spanning],
      "2026-08-14": [spanning],
      "2026-08-15": [spanning],
      "2026-08-16": [spanning],
    });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: NOW }));
    const marked = document.querySelectorAll('[aria-current="true"]');
    assert.equal(marked.length, 1);
    assert.ok(cell("2026-08-14").contains(marked[0]), "the highlight belongs on today's square");
  });
});

describe("tag colour", () => {
  test("keeps a tag colour that would be invisible readable", () => {
    // Near-black on the kiosk backdrop is a dot that is not there. The org's own
    // Calendar constrains nothing, and the real data contains both extremes.
    for (const raw of ["#000000", "#0b0b0b", "#101418", "#1a0f0f"]) {
      const fixed = readableTagColor(raw);
      assert.ok(fixed, raw);
      assert.ok(
        contrastRatio(fixed, KIOSK_BACKDROP) >= 3,
        `${raw} -> ${fixed} is ${contrastRatio(fixed, KIOSK_BACKDROP).toFixed(2)}:1 against the backdrop`,
      );
    }
  });

  test("leaves a colour that already reads alone", () => {
    // Including the near-white and the lavender that are in the real data. The
    // zero-purple rule is about app chrome; this is the organisation's own data
    // and is not ours to correct.
    for (const raw of ["#e0e0e0", "#b4a7e6", "#f9d266", "#1d9a8c"]) {
      assert.equal(readableTagColor(raw), raw);
    }
  });

  test("has no colour to show for an untagged event", () => {
    assert.equal(readableTagColor(null), null);
  });

  test("draws the tag colour on the event", () => {
    const g = grid({
      "2026-08-14": [
        event("tagged", "2026-08-14T14:00:00Z", "2026-08-14T15:00:00Z", {
          tags: [{ id: "t1", name: "Alpha Ministry", color: "#1d9a8c" }],
        }),
      ],
    });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: Date.parse("2026-08-10T18:00:00Z") }));
    const swatch = cell("2026-08-14").querySelector("[data-tag-color]") as HTMLElement | null;
    assert.ok(swatch, "the tag colour never reached the DOM");
    assert.equal(swatch.dataset.tagColor, "#1d9a8c");
  });
});

describe("empty and broken states", () => {
  test("says so when the window is empty rather than drawing a blank grid", () => {
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: grid(), nowMs: Date.parse("2026-08-14T18:00:00Z") }));
    assert.ok(screen.getByText(/nothing on the calendar/i));
  });

  test("says Planning Center is not connected rather than blaming an empty month", () => {
    render(
      React.createElement(CalendarMonth, {
        grid: grid(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
        pcoConfigured: false,
      }),
    );
    assert.ok(screen.getByText(/planning center/i));
  });

  test("says the read failed rather than showing a month that is merely empty", () => {
    // The route answers 502 when PCO cannot be reached. An empty grid would be a
    // lie, and a calendar that quietly empties itself is the failure nobody
    // reports.
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: null, nowMs: 0, failed: true }));
    assert.ok(screen.getByText(/could not read/i));
  });

  test("keeps the last good month up when a LATER read fails, and marks it stale", () => {
    // Throwing away a correct month because the next poll failed is worse than
    // showing one a few minutes old. The first version of this dropped the
    // failure entirely once a grid had loaded: the month simply stopped
    // updating, with nothing on screen to say so.
    const g = grid({ "2026-08-14": [event("a", "2026-08-14T19:00:00Z", "2026-08-14T20:00:00Z")] });
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: g,
        nowMs: Date.parse("2026-08-10T18:00:00Z"),
        failed: true,
      }),
    );
    assert.equal(screen.getAllByRole("gridcell").length, 42, "the month was thrown away");
    assert.ok(cell("2026-08-14").textContent?.includes("Event a"), "its events went with it");
    assert.ok(screen.getByText(/could not reach planning center/i), "nothing said it was stale");
  });

  test("a failure outranks the empty-month note, which would be the wrong story", () => {
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: grid(),
        nowMs: Date.parse("2026-08-10T18:00:00Z"),
        failed: true,
      }),
    );
    assert.equal(screen.queryByText(/nothing on the calendar/i), null);
    assert.ok(screen.getByText(/could not reach planning center/i));
  });
});
