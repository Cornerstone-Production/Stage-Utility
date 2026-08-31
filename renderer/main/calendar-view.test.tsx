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
import { readFileSync } from "node:fs";
import { after, afterEach, beforeEach, describe, it, test } from "node:test";

import { installDom } from "../test-dom.js";
import type { CalendarEventDTO, CalendarGrid } from "@main/types/calendar";

const teardown = installDom();

// CalendarMonth is handed its grid and fetches nothing; CalendarView does, and
// the navigation suite at the bottom reads what it asked for. The stub also keeps
// a stray call from settling after teardown and failing the whole FILE while
// every test in it passes.
let sent: { url: string; method: string }[] = [];
/** Set to fail any request whose URL carries a `month=` — a paged month 502ing
 *  while the live channel is perfectly healthy, which is the real case. */
let failPagedMonths = false;
/** A 200 carrying a null body. Not a hypothetical: apiFetch resolves with
 *  whatever the body parsed to, so this is what the calendar sees whenever the
 *  route answers OK with nothing in it. */
let liveGridIsNull = false;
/** Hold the LIVE grid request open, so a push can be made to land before it. Set
 *  by the ordering test and answered by hand through `answerLiveGrid`. */
let holdLiveGrid = false;
let answerLiveGrid: ((body: unknown) => void) | null = null;
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
  sent.push({ url, method: init?.method ?? "GET" });
  if (holdLiveGrid && url.includes("/api/pco/calendar") && !url.includes("month=")) {
    return new Promise((res) => {
      answerLiveGrid = (body: unknown) =>
        res({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    });
  }
  if (failPagedMonths && url.includes("month=")) {
    return { ok: false, status: 502, json: async () => ({ error: "down" }), text: async () => '{"error":"down"}' };
  }
  if (liveGridIsNull && url.includes("/api/pco/calendar") && !url.includes("month=")) {
    return { ok: true, status: 200, json: async () => null, text: async () => "null" };
  }
  // A real grid for the calendar route: CalendarView renders a notice rather
  // than a header until it has one, and the chevrons live in the header.
  const payload = url.includes("/api/pco/calendar") ? grid() : {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

// EventSource for the pushed calendar:grid channel. It records its listeners so
// a test can DELIVER a frame — the server-side push has its own tests in
// main/services/calendar-broadcaster.test.ts, but what the component does when a
// frame lands can only be checked here.
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

/** Deliver one `calendar:grid` frame, exactly as the server's fan-out would. */
function pushFrame(payload: unknown): void {
  for (const fn of sseHandlers.get("calendar:grid") ?? []) fn({ data: JSON.stringify(payload) });
}

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CalendarMonth, CalendarView, readableTagColor, visibleEvents, KIOSK_BACKDROP, MIN_CONTRAST } =
  await import("./calendar-view.js");
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
beforeEach(() => {
  cleanup();
  sent = [];
  failPagedMonths = false;
  liveGridIsNull = false;
  holdLiveGrid = false;
  answerLiveGrid = null;
});
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
    // By data-date, not by role: an event list inside a square is a <ul> whose
    // rows carry the implicit listitem role too, so a role query would count
    // squares plus events on any grid that had some. The squares' ARIA is
    // guarded on its own, below.
    assert.equal(document.querySelectorAll("[data-date]").length, 42);
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

/**
 * Which owning role each ARIA role has to sit inside, per WAI-ARIA's "required
 * context role". Only the ones a month grid could plausibly grow.
 */
const REQUIRED_OWNER: Record<string, string[]> = {
  gridcell: ["row"],
  cell: ["row"],
  columnheader: ["row"],
  rowheader: ["row"],
  row: ["grid", "table", "treegrid", "rowgroup"],
  rowgroup: ["grid", "table", "treegrid"],
  listitem: ["list"],
  option: ["listbox"],
  tab: ["tablist"],
};

/** Every element carrying an explicit role whose required owner is missing. */
function orphanedRoles(root: HTMLElement): string[] {
  const bad: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[role]")) {
    const role = el.getAttribute("role") ?? "";
    const owners = REQUIRED_OWNER[role];
    if (!owners) continue;
    let p = el.parentElement;
    let found = false;
    while (p && !found) {
      // A presentational wrapper is transparent to the ownership chain, which is
      // what a `display: contents` row layer would rely on. Anything else with a
      // role of its own ends the search: an intervening role means this element
      // is owned by THAT, not by something further up.
      const pr = p.getAttribute("role");
      if (pr && pr !== "presentation" && pr !== "none") {
        found = owners.includes(pr);
        break;
      }
      p = p.parentElement;
    }
    if (!found) bad.push(role);
  }
  return bad;
}

describe("the month's ARIA describes a structure that is actually there", () => {
  // THE BUG. The month was `role="grid"` over forty-two DIRECT `role="gridcell"`
  // children and no `role="row"` anywhere. Invalid ARIA is worse than none: a
  // screen reader is asked to report a position in rows that do not exist, and
  // `grid` additionally promises arrow-key navigation between cells that has
  // never existed here — the squares are not focusable.
  //
  // WHAT JSDOM CANNOT SAY: how any of this is announced. No AT runs here, and
  // nothing is laid out, so "a reader says row 3 of 6" is not checkable and is
  // not asserted. What IS checkable is the ownership chain the roles claim, and
  // that is what the walk below reads — off the rendered DOM, not off the
  // source, so a comment naming a role cannot satisfy it.
  test("THE GUARD: no role sits outside the role that has to own it", () => {
    const { container } = render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: grid({ "2026-08-14": [event("a", "2026-08-14T19:00:00Z", "2026-08-14T20:00:00Z")] }),
        nowMs: Date.parse("2026-08-10T18:00:00Z"),
      }),
    );
    assert.deepEqual(
      orphanedRoles(container),
      [],
      "a role in the month grid has no element of the role that must own it",
    );
  });

  test("and it is a list of forty-two squares, exactly", () => {
    // Exact counts, not floors. A fix that dropped `role="gridcell"` and forgot
    // to give the squares anything at all would leave the walk above green —
    // there is nothing left to be orphaned — while taking the whole structure
    // out of the reading.
    const { container } = render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: grid(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
      }),
    );
    const count = (role: string) => container.querySelectorAll(`[role="${role}"]`).length;
    assert.equal(count("list"), 1, "the month is not one list");
    assert.equal(count("listitem"), 42, "the month is not forty-two squares");
    assert.equal(count("grid"), 0, "the composite grid role is back");
    assert.equal(count("gridcell"), 0, "the gridcell role is back");
    assert.equal(
      container.querySelector('[role="list"]')?.getAttribute("aria-label"),
      "August 2026",
      "the list lost the month's name",
    );
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

    // aria-current is not the highlight. The pill SHIPPED as a font-weight
    // change and nothing else — written against bg-fill-strong, which is not a
    // token, so Tailwind emitted nothing — and every test here stayed green
    // because they all asserted aria-current. What a person in the room sees is
    // the fill and the ring, so those are what is asserted.
    //
    // jsdom has no stylesheet and no layout: it cannot say what any of these
    // classes PAINT. The class list is the most this can check, and it is
    // checked against the row that is NOT running so a class both rows carry
    // could not satisfy it.
    const pill = marked[0].className.split(/\s+/);
    for (const cls of ["bg-fill-active", "ring-1", "ring-accent", "text-fg"]) {
      assert.ok(pill.includes(cls), `the running event carries no ${cls}: ${marked[0].className}`);
    }
  });

  test("does not give a quiet event the running event's fill", () => {
    // The other half of the same guard: if these classes were on every row the
    // assertion above would pass with no highlight on the wall at all.
    const g = grid({ "2026-08-14": [event("done", "2026-08-14T14:00:00Z", "2026-08-14T15:00:00Z")] });
    render(React.createElement(CalendarMonth, { pcoConfigured: true, grid: g, nowMs: NOW }));
    const row = cell("2026-08-14").querySelector("li");
    assert.ok(row, "the event never rendered");
    const quiet = row.className.split(/\s+/);
    for (const cls of ["bg-fill-active", "ring-accent"]) {
      assert.ok(!quiet.includes(cls), `a quiet event carries ${cls}: ${row.className}`);
    }
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
        contrastRatio(fixed, KIOSK_BACKDROP) >= MIN_CONTRAST,
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
    // The data attribute is read by nothing but this test. Deleting the inline
    // style renders the swatch invisible and leaves the line above green, so the
    // PAINTED value is what the guard rests on — jsdom does model inline style,
    // and normalises a hex to rgb().
    assert.equal(swatch.style.backgroundColor, "rgb(29, 154, 140)");
  });
});

describe("the contrast floor is tied to its sources", () => {
  // Both literals used to live in this file with nothing joining them to the
  // values they stand for. Change --kiosk-bg, or raise the floor in the
  // component, and the suite would go on measuring against the old ones and stay
  // green while the wall got less readable. install-metadata.test.ts already
  // holds the <meta theme-color> to --kiosk-bg the same way.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

  test("KIOSK_BACKDROP is the --kiosk-bg the stylesheet paints", () => {
    const declared = [...css.matchAll(/--kiosk-bg:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => m[1]);
    assert.deepEqual(declared, [KIOSK_BACKDROP], "the calendar's backdrop drifted from --kiosk-bg");
  });

  test("the suite measures against the component's own floor", () => {
    // Imported, not restated: raising MIN_CONTRAST must raise what is asserted.
    assert.equal(typeof MIN_CONTRAST, "number");
    for (const raw of ["#000000", "#0b0b0b"]) {
      const fixed = readableTagColor(raw);
      assert.ok(fixed);
      assert.ok(contrastRatio(fixed, KIOSK_BACKDROP) >= MIN_CONTRAST, `${raw} -> ${fixed}`);
    }
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
    assert.equal(document.querySelectorAll("[data-date]").length, 42, "the month was thrown away");
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
    assert.ok(
      screen.queryByText(/nothing on the calendar/i) === null,
      "an empty-month note went out over a failure, which is the wrong story",
    );
    assert.ok(screen.getByText(/could not reach planning center/i));
  });
});


// ── month navigation ─────────────────────────────────────────────────────────
//
// What these guard:
//
// 1. THE OFFSET IS NOT SHARED. A View can be routed to several screens at once,
//    so an offset kept in its config would page every wall in the building
//    because one operator looked at December.
// 2. A WALL DISPLAY HAS NO CONTROLS AND CANNOT PAGE. Nobody is standing at it.
// 3. RETURNING TO THE CURRENT MONTH READS THE LIVE CHANNEL. Serving the current
//    month from the one-shot path instead looks harmless and freezes the
//    display on a copy taken at page time.
// 4. A BAD `month` IS REJECTED, not coerced to today.
//
// All four proven red in the session that wrote them.

describe("the month chevrons", () => {
  const g = () => grid();

  it("are absent when CalendarMonth is given no nav", () => {
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: g(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
        nav: null,
      }),
    );
    assert.ok(
      screen.queryByRole("button", { name: /previous month/i }) === null,
      "a chevron rendered with no nav supplied",
    );
    assert.ok(
      screen.queryByRole("button", { name: /next month/i }) === null,
      "a chevron rendered with no nav supplied",
    );
  });

  it("are present, and are real buttons, where controls are live", () => {
    // Real <button>s so they are tab-reachable and fire on Enter and Space
    // without any of that being reimplemented.
    const nav = { offset: 0, canPrev: true, canNext: true, onPrev() {}, onNext() {}, onToday() {} };
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: g(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
        nav,
      }),
    );
    const prev = screen.getByRole("button", { name: /previous month/i });
    assert.equal(prev.tagName, "BUTTON");
    assert.equal(prev.getAttribute("type"), "button");
  });

  it("stop at the paging bound rather than walking off it", () => {
    const nav = { offset: -36, canPrev: false, canNext: true, onPrev() {}, onNext() {}, onToday() {} };
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: g(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
        nav,
      }),
    );
    assert.equal((screen.getByRole("button", { name: /previous month/i }) as HTMLButtonElement).disabled, true);
    assert.equal((screen.getByRole("button", { name: /next month/i }) as HTMLButtonElement).disabled, false);
  });

  it("offers Today only once paged away, since on 0 it would do nothing", () => {
    const base = { canPrev: true, canNext: true, onPrev() {}, onNext() {}, onToday() {} };
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: g(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
        nav: { ...base, offset: 0 },
      }),
    );
    assert.ok(
      screen.queryByRole("button", { name: /^today$/i }) === null,
      "Today offered on the current month, where it would do nothing",
    );
    cleanup();
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: g(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
        nav: { ...base, offset: 2 },
      }),
    );
    assert.ok(screen.getByRole("button", { name: /^today$/i }));
  });

  it("says a PAGED month could not be read, not that the live one went stale", () => {
    // Different sentences on purpose: one is "the thing you just asked for
    // failed", the other is "what you are looking at has stopped updating".
    render(
      React.createElement(CalendarMonth, {
        pcoConfigured: true,
        grid: g(),
        nowMs: Date.parse("2026-08-14T18:00:00Z"),
        failed: true,
        nav: { offset: -1, canPrev: true, canNext: true, onPrev() {}, onNext() {}, onToday() {} },
      }),
    );
    assert.ok(screen.getByText(/could not read that month/i));
    assert.ok(
      screen.queryByText(/showing the last month read/i) === null,
      "a paged-month failure claimed the LIVE month had gone stale",
    );
  });
});

describe("paging is per screen, and the current month stays live", () => {
  // The mount fetch resolves through a couple of macrotasks before the header —
  // and therefore the chevrons — exist. The file-wide settle() is a single
  // setTimeout(0), which is enough for a component handed its data and not for
  // one that fetches it.
  const mounted = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 10));
  };

  /**
   * Long enough to outlast the paged fetch's 250ms debounce.
   *
   * Required for anything asserting which requests were NOT made: a shorter wait
   * ends before the debounced fetch can fire, so the assertion passes because the
   * test was quick rather than because the code was right — which is exactly how
   * the current-month guard first passed with the live path broken.
   */
  const pastDebounce = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 60));
  };

  /** Two mounted CalendarViews over the same view id, as two screens would be. */
  const twoScreens = () =>
    render(
      React.createElement(
        "div",
        null,
        React.createElement(CalendarView, { key: "a", viewId: "v-1", pcoConfigured: true, interactive: true }),
        React.createElement(CalendarView, { key: "b", viewId: "v-1", pcoConfigured: true, interactive: true }),
      ),
    );

  it("does not page the OTHER screen showing the same view", async () => {
    // The offset lives in React state, per mounted instance. Moving it into the
    // View's config makes both move together, which is the bug.
    twoScreens();
    await mounted();
    const nexts = screen.getAllByRole("button", { name: /next month/i });
    assert.equal(nexts.length, 2, "expected one pair of chevrons per screen");

    // queryAllByRole, not getAllByRole: the getAll* family THROWS on zero
    // matches, so asserting "none yet" with it fails the test on the very
    // condition it is asserting.
    assert.equal(screen.queryAllByRole("button", { name: /^today$/i }).length, 0, "neither screen has paged yet");

    fireEvent.click(nexts[0]);
    await mounted();

    // Exactly ONE screen has paged: only it offers a way back to today.
    assert.equal(
      screen.queryAllByRole("button", { name: /^today$/i }).length,
      1,
      "paging one screen paged the other as well",
    );
  });

  it("gives a WALL DISPLAY no chevrons at all", async () => {
    // The gate lives in CalendarView, which decides nav-or-null from
    // `interactive`. Handing CalendarMonth a null nav only proves CalendarMonth
    // draws what it is given — the first version of this test did exactly that
    // and stayed green with the gate deleted.
    render(React.createElement(CalendarView, { viewId: "v-1", pcoConfigured: true, interactive: false }));
    await mounted();
    assert.equal(screen.queryAllByRole("button", { name: /previous month/i }).length, 0);
    assert.equal(screen.queryAllByRole("button", { name: /next month/i }).length, 0);
  });

  it("never asks for a paged month on a wall display", async () => {
    // Belt and braces on the same gate: even if an offset were somehow set, a
    // display must not start fetching months.
    sent = [];
    render(React.createElement(CalendarView, { viewId: "v-1", pcoConfigured: true, interactive: false }));
    await pastDebounce();
    assert.deepEqual(
      sent.filter((r) => r.url.includes("month=")),
      [],
    );
  });

  it("clears a paged month's failure on returning to today", async () => {
    // The bug this exists for: one `failed` boolean served both fetch paths, so
    // a paged month that 502'd left "Could not reach Planning Center — showing
    // the last month read" sitting over a current grid on a healthy channel —
    // and, by this feature's own design, it cleared only on the next pushed
    // frame, which for a calendar is a couple of times a WEEK.
    failPagedMonths = true;
    render(React.createElement(CalendarView, { viewId: "v-1", pcoConfigured: true, interactive: true }));
    await mounted();

    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    await pastDebounce();
    assert.ok(screen.queryByText(/could not read that month/i), "the paged failure never showed");

    fireEvent.click(screen.getByRole("button", { name: /^today$/i }));
    await mounted();

    assert.ok(
      screen.queryByText(/could not reach planning center/i) === null,
      "the live month inherited the paged month's failure",
    );
    assert.ok(
      screen.queryByText(/could not read that month/i) === null,
      "the paged failure survived the return to today",
    );
    assert.ok(screen.getByRole("list", { name: "August 2026" }), "the live month is not on screen at all");
  });

  it("does not let a pushed frame clear a PAGED month's failure", async () => {
    // The same shared boolean, the other way round: the ordinary three-minute
    // push called setFailed(false) while the paged grid was still null, which
    // left "Loading the calendar…" up for ever with nothing loading and nothing
    // that ever would.
    failPagedMonths = true;
    render(React.createElement(CalendarView, { viewId: "v-1", pcoConfigured: true, interactive: true }));
    await mounted();

    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    await pastDebounce();
    assert.ok(screen.queryByText(/could not read that month/i), "the paged failure never showed");

    // A routine push lands while the operator is still looking at the failed
    // month. It is news about the current month and about nothing else.
    act(() => {
      pushFrame({ "v-1": grid() });
    });
    await mounted();

    assert.ok(
      screen.queryByText(/loading the calendar/i) === null,
      "a pushed frame turned the paged failure into a spinner that never resolves",
    );
    assert.ok(screen.queryByText(/could not read that month/i), "the paged failure was cleared by unrelated news");
  });

  it("does not let an older read undo the grid a push already delivered", async () => {
    // The wall-shows-the-wrong-department bug. The read and the subscription used
    // to be two effects, the read declared first, with nothing ordering them: a
    // display mounts and its GET is served at T0; at T0+e the operator changes the
    // view's filters and view-routes forces a refresh, which pushes the NEW grid;
    // the client applies the push and then the older response resolves and puts
    // the pre-change month back. calendar-broadcaster only sends on a signature
    // change and its signature already matches, so the three-minute timer never
    // re-sends and the wall stays wrong until somebody reloads it.
    //
    // A rev cannot settle this — calendar-broadcaster.ts's header says nothing in
    // the payload is a per-fetch value — so what is asserted is the ORDERING: a
    // live frame beats a read that was already in flight.
    //
    // Its own view id, because api.ts replays the last frame of a hydrated channel
    // to a late subscriber and a v-1 mount would be handed what an earlier case
    // here pushed.
    holdLiveGrid = true;
    render(React.createElement(CalendarView, { viewId: "v-race", pcoConfigured: true, interactive: true }));
    await mounted(); // subscribed; the read is still in flight

    // The operator's new filters, pushed while that read is open.
    act(() => {
      pushFrame({
        "v-race": grid({ "2026-08-12": [event("pushed", "2026-08-12T15:00:00Z", "2026-08-12T16:00:00Z")] }),
      });
    });
    await mounted();
    assert.ok(screen.queryByText("Event pushed"), "the pushed grid never reached the screen");

    // Now the older response lands, carrying the department the operator just
    // filtered away.
    await act(async () => {
      answerLiveGrid!(
        grid({ "2026-08-12": [event("stale", "2026-08-12T15:00:00Z", "2026-08-12T16:00:00Z")] }),
      );
      await mounted();
    });

    assert.ok(
      screen.queryByText("Event pushed"),
      "an older read replaced the grid a push had already delivered — the broadcaster " +
        "will not re-send, so the wall stays on the wrong month until it is reloaded",
    );
    assert.equal(screen.queryByText("Event stale"), null, "the stale month is on screen");
  });

  it("does not spin for ever on a 200 that carries no grid", async () => {
    // The bug: `setLiveFailed(false); if (g) setLiveGrid(g);`. apiFetch resolves
    // with res.json(), so an OK response with a null body lands in the SUCCESS
    // arm with g === null — the failure flag cleared, no grid stored, and
    // "Loading the calendar…" on the wall for ever with nothing loading and
    // nothing that ever would. The paged read a few lines below always treated
    // the two the same.
    liveGridIsNull = true;
    // A view id of its own, not v-1: renderer/lib/api.ts replays the last frame
    // of a hydrated channel to every late subscriber, so a v-1 mount here would
    // be handed the grid an earlier test in this suite pushed and the read's
    // answer would never be what is on screen.
    render(React.createElement(CalendarView, { viewId: "v-empty", pcoConfigured: true, interactive: true }));
    await pastDebounce();

    assert.ok(
      screen.queryByText(/loading the calendar/i) === null,
      "an empty 200 left the permanent spinner up",
    );
    assert.ok(screen.getByText(/could not read the calendar/i));
  });

  it("says so rather than freezing when it is handed no view to show", async () => {
    // stage-view passes `activeView?.id ?? null`. The push effect has always
    // been gated on the id — it has nothing to key the payload by without one —
    // so a hydrate that ran anyway fetched the UNFILTERED grid once and then sat
    // frozen at mount for the life of the page, looking perfectly current.
    sent = [];
    render(React.createElement(CalendarView, { viewId: null, pcoConfigured: true, interactive: true }));
    await pastDebounce();

    assert.deepEqual(
      sent.filter((r) => r.url.includes("/api/pco/calendar")),
      [],
      "fetched a grid it could never receive an update for",
    );
    assert.ok(
      screen.queryByText(/loading the calendar/i) === null,
      "a view-less calendar sat on a spinner that resolves to nothing",
    );
    assert.ok(screen.getByText(/could not read the calendar/i));

    // And PAGING does not get round it. The gate was on the live read alone at
    // first; api.ts omits the parameter for a null id, so one press of a chevron
    // fetched the UNFILTERED grid and drew every calendar in the organisation,
    // frozen and with no way to filter it — one click outside the assertions
    // above.
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));
    await pastDebounce();
    assert.deepEqual(
      sent.filter((r) => r.url.includes("/api/pco/calendar")),
      [],
      "paging a view-less calendar fetched the unfiltered month",
    );
    assert.ok(
      screen.queryByText(/loading the calendar/i) === null,
      "paging swapped the notice for a spinner that resolves to nothing",
    );
  });

  it("asks for the current month with NO month parameter, so it is the live one", async () => {
    // The current month must come off the pushed channel. A `month=` on the
    // mount fetch is the tell that it is being served from the one-shot path.
    sent = [];
    render(React.createElement(CalendarView, { viewId: "v-1", pcoConfigured: true, interactive: true }));
    await pastDebounce();
    const calls = sent.filter((r) => r.url.includes("/api/pco/calendar"));
    assert.equal(calls.length, 1, `expected one hydrate, saw ${JSON.stringify(calls.map((c) => c.url))}`);
    assert.ok(!calls[0].url.includes("month="), `the current month was fetched as a paged month: ${calls[0].url}`);
  });
});
