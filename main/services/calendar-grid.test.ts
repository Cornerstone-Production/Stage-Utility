// What this file guards, and why each one is here.
//
// 1. BUCKETING HAPPENS IN THE APP ZONE. All-day events arrive from PCO as local
//    midnight expressed in UTC ("05:00Z" in a UTC-5 zone), and the app's servers
//    run UTC. Bucketing on the UTC date puts every all-day event on the wrong
//    square for half the year, and every evening event on the wrong square after
//    19:00 local — the same class of failure that once stopped every recorder
//    mid-service.
//
// 2. THE WINDOW COVERS THE WHOLE VISIBLE GRID. A six-week grid shows leading and
//    trailing days of the adjacent months. A window of the calendar MONTH leaves
//    those squares silently empty, and an empty square is indistinguishable from
//    a day with nothing on it.
//
// Both were proven red in the session that wrote them: bucketing was switched to
// the UTC date and the all-day and late-evening tests failed; the window was
// narrowed to the calendar month and the window test failed.
//
// Every id, name and colour below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CalendarEventDTO } from "../types/calendar.js";
import { buildGrid, gridWindow, monthAnchor, monthOffsetOf, MAX_MONTH_OFFSET } from "./calendar-grid.js";

/** UTC-6 in winter, UTC-5 in summer — the zone the bucketing bug shows up in. */
const ZONE = "America/Chicago";

function event(id: string, startsAt: string, endsAt = startsAt, allDay = false): CalendarEventDTO {
  return {
    id,
    name: `Event ${id}`,
    startsAt,
    endsAt,
    allDay,
    location: null,
    churchCenterUrl: null,
    tags: [],
  };
}

/** The day square an event landed on, or null when it landed on none. */
function dayOf(grid: { days: { date: string; events: CalendarEventDTO[] }[] }, id: string): string | null {
  const hit = grid.days.find((d) => d.events.some((e) => e.id === id));
  return hit?.date ?? null;
}

function daysOf(grid: { days: { date: string; events: CalendarEventDTO[] }[] }, id: string): string[] {
  return grid.days.filter((d) => d.events.some((e) => e.id === id)).map((d) => d.date);
}

describe("bucketing happens in the app zone, not UTC", () => {
  it("puts an all-day event on its LOCAL day", () => {
    // Verified live: an all-day event arrives as local midnight expressed in
    // UTC. West of Greenwich that instant still carries the right UTC date, so
    // this is asserted EAST of it, where local midnight on the 15th is 13:00Z on
    // the 14th and a UTC bucket is unambiguously a day early. A zone the app can
    // legitimately be set to, and the only version of this test that bites.
    const grid = buildGrid(
      [event("a", "2026-01-14T13:00:00Z", "2026-01-15T12:59:59Z", true)],
      "2026-01-10T12:00:00Z",
      "Pacific/Auckland",
    );
    assert.equal(dayOf(grid, "a"), "2026-01-15");
  });

  it("puts an all-day event on its local day when UTC has already rolled over", () => {
    // The failure the UTC bucket actually produces: an all-day event whose UTC
    // instant is the 16th but whose local date is the 15th. There is no such
    // instant for a UTC-6 zone at 00:00 local, so use the other end — the
    // 23:00-local instant a single-day event can carry.
    const grid = buildGrid([event("b", "2026-01-16T05:00:00Z")], "2026-01-10T12:00:00Z", ZONE);
    assert.equal(dayOf(grid, "b"), "2026-01-15", "23:00 on the 15th locally, not the 16th");
  });

  it("puts a late-evening event on the day it happened locally", () => {
    // 2026-08-25T02:30:00Z is the 24th at 21:30 in America/Chicago. A UTC bucket
    // files it under the 25th and the operator sees it on the wrong square.
    const grid = buildGrid([event("c", "2026-08-25T02:30:00Z", "2026-08-25T04:00:00Z")], "2026-08-10T12:00:00Z", ZONE);
    assert.equal(dayOf(grid, "c"), "2026-08-24");
  });

  it("reports the zone it bucketed in, so the renderer formats times the same way", () => {
    // The renderer has no access to app-timezone and a browser in another zone
    // would otherwise print every event time an offset out.
    assert.equal(buildGrid([], "2026-08-10T12:00:00Z", ZONE).zone, ZONE);
  });
});

describe("the shape of the grid", () => {
  it("always returns 42 days, so the grid does not reflow between months", () => {
    // February 2026 starts on a Sunday and is 28 days — the month that most
    // tempts a five-week grid.
    for (const anchor of ["2026-02-10T12:00:00Z", "2026-08-10T12:00:00Z", "2026-11-10T12:00:00Z"]) {
      assert.equal(buildGrid([], anchor, ZONE).days.length, 42, anchor);
    }
  });

  it("starts on the Sunday on or before the first of the month", () => {
    // 1 March 2026 is a Sunday; 1 August 2026 is a Saturday.
    assert.equal(buildGrid([], "2026-03-10T12:00:00Z", ZONE).days[0].date, "2026-03-01");
    assert.equal(buildGrid([], "2026-08-10T12:00:00Z", ZONE).days[0].date, "2026-07-26");
  });

  it("names the month from the anchor's LOCAL month", () => {
    // 2026-09-01T02:00:00Z is still 31 August in Chicago, so the grid the
    // operator asked for is August's.
    assert.equal(buildGrid([], "2026-09-01T02:00:00Z", ZONE).monthLabel, "August 2026");
    assert.equal(buildGrid([], "2026-09-01T02:00:00Z", "UTC").monthLabel, "September 2026");
  });

  it("marks which squares belong to the anchor month", () => {
    const grid = buildGrid([], "2026-08-10T12:00:00Z", ZONE);
    assert.equal(grid.days[0].inMonth, false, "2026-07-26 is a leading day");
    assert.equal(grid.days.filter((d) => d.inMonth).length, 31, "August has 31 days");
  });
});

describe("spanning", () => {
  it("spans a multi-day event across every day it touches", () => {
    // A retreat: Thursday evening to Sunday afternoon, local.
    const grid = buildGrid(
      [event("r", "2026-08-14T00:00:00Z", "2026-08-16T20:00:00Z")],
      "2026-08-10T12:00:00Z",
      ZONE,
    );
    assert.deepEqual(daysOf(grid, "r"), ["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]);
  });

  it("does not smear an event that ends exactly at local midnight onto the next day", () => {
    // An 8pm-to-midnight booking belongs to one evening, not two days.
    const grid = buildGrid(
      [event("m", "2026-08-14T01:00:00Z", "2026-08-14T05:00:00Z")],
      "2026-08-10T12:00:00Z",
      ZONE,
    );
    assert.deepEqual(daysOf(grid, "m"), ["2026-08-13"]);
  });

  it("clips a span to the visible grid rather than dropping it", () => {
    // An event that started before the grid must still show on the days of it
    // that ARE visible. Dropping it is the multi-day failure one square over.
    const grid = buildGrid(
      [event("s", "2026-07-20T15:00:00Z", "2026-07-28T15:00:00Z")],
      "2026-08-10T12:00:00Z",
      ZONE,
    );
    assert.deepEqual(daysOf(grid, "s"), ["2026-07-26", "2026-07-27", "2026-07-28"]);
  });

  it("keeps an event entirely outside the grid off it", () => {
    const grid = buildGrid([event("x", "2026-01-05T15:00:00Z")], "2026-08-10T12:00:00Z", ZONE);
    assert.equal(dayOf(grid, "x"), null);
  });
});

describe("ordering within a day", () => {
  it("puts all-day events first, then the timed ones in time order", () => {
    const grid = buildGrid(
      [
        event("late", "2026-08-14T23:00:00Z", "2026-08-15T00:00:00Z"),
        event("early", "2026-08-14T14:00:00Z", "2026-08-14T15:00:00Z"),
        event("allday", "2026-08-14T05:00:00Z", "2026-08-15T04:59:59Z", true),
      ],
      "2026-08-10T12:00:00Z",
      ZONE,
    );
    const day = grid.days.find((d) => d.date === "2026-08-14");
    assert.deepEqual(day?.events.map((e) => e.id), ["allday", "early", "late"]);
  });
});

describe("gridWindow", () => {
  it("windows the query to the whole visible grid, not the calendar month", () => {
    // The six-week grid for August 2026 runs 26 July to 5 September. A window of
    // the calendar month leaves ten squares silently empty.
    const w = gridWindow("2026-08-10T12:00:00Z", ZONE);
    assert.equal(w.fromIso, "2026-07-26T05:00:00.000Z", "midnight on 26 July, Chicago");
    assert.ok(w.toIso > "2026-09-05T05:00:00.000Z", `covers 5 September, got ${w.toIso}`);
    assert.ok(w.toIso < "2026-09-06T06:00:00.000Z", `does not run past 5 September, got ${w.toIso}`);
  });

  it("returns explicit instants the calendar client will accept", () => {
    // The client throws on a bare date, because PCO reads one in the ORG's zone.
    const w = gridWindow("2026-08-10T12:00:00Z", ZONE);
    for (const iso of [w.fromIso, w.toIso]) {
      assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, iso);
    }
  });

  it("shifts with the zone, because midnight does", () => {
    assert.notEqual(gridWindow("2026-08-10T12:00:00Z", "UTC").fromIso, gridWindow("2026-08-10T12:00:00Z", ZONE).fromIso);
  });

  it("crosses a spring-forward boundary without losing the day", () => {
    // US DST begins 8 March 2026. The grid for March starts 1 March and must
    // still land on local midnight on both sides of the change.
    const w = gridWindow("2026-03-15T12:00:00Z", ZONE);
    assert.equal(w.fromIso, "2026-03-01T06:00:00.000Z", "CST, UTC-6");
    // 42 days from 1 March ends on 11 April, whose last second is 04:59:59Z on
    // the 12th — one hour later than the start bound's offset, because the
    // clocks moved in between.
    assert.equal(w.toIso, "2026-04-12T04:59:59.000Z", "CDT, UTC-5");
  });
});

describe("bad input", () => {
  it("throws on an anchor that is not an instant rather than guessing a month", () => {
    assert.throws(() => buildGrid([], "2026-08-10", ZONE), /instant/i);
    assert.throws(() => gridWindow("not a date", ZONE), /instant/i);
  });

  it("drops an event whose times will not parse, and says how many", () => {
    // The mapper upstream guarantees ISO, so this is a contract breach rather
    // than a routine case — but a NaN date silently becomes "Invalid Date" and
    // lands on no square at all, which is the failure this whole file is
    // written against.
    const grid = buildGrid([event("bad", "nonsense")], "2026-08-10T12:00:00Z", ZONE);
    assert.equal(grid.days.every((d) => d.events.length === 0), true);
    assert.equal(grid.unplaceable, 1);
  });
});

describe("paging to another month", () => {
  // 14:00Z on the last day of August is 09:00 on the 31st in Chicago, and
  // 2026-09-01 in UTC only three hours earlier than it is anywhere. The whole
  // point of these is that the app zone decides, not the host.
  const LAST_DAY = Date.parse("2026-09-01T02:00:00Z"); // still 31 Aug in Chicago

  it("resolves the current month in the APP zone, not the host's", () => {
    // A UTC box on the evening of the 31st has already rolled into September.
    // If that decided the month, every display in the building would page
    // forward for five hours.
    assert.equal(buildGrid([], monthAnchor(0, ZONE, LAST_DAY), ZONE).monthLabel, "August 2026");
    assert.equal(buildGrid([], monthAnchor(0, "UTC", LAST_DAY), "UTC").monthLabel, "September 2026");
  });

  it("steps whole months, and across a year boundary", () => {
    const label = (n: number) => buildGrid([], monthAnchor(n, ZONE, LAST_DAY), ZONE).monthLabel;
    assert.equal(label(1), "September 2026");
    assert.equal(label(-1), "July 2026");
    assert.equal(label(5), "January 2027");
    assert.equal(label(-8), "December 2025");
  });

  it("lands mid-month, so no offset can tip into an adjacent one", () => {
    // The anchor only has to fall INSIDE the right month. Anchoring on midnight
    // of the 1st leaves no margin at all in a zone behind UTC.
    for (let n = -MAX_MONTH_OFFSET; n <= MAX_MONTH_OFFSET; n++) {
      const label = buildGrid([], monthAnchor(n, ZONE, LAST_DAY), ZONE).monthLabel;
      assert.ok(/^[A-Z][a-z]+ \d{4}$/.test(label), `${n} produced "${label}"`);
    }
  });

  it("REFUSES an offset outside the paging bound rather than clamping it", () => {
    // A silent clamp draws a different month than the one asked for and says
    // nothing, which is the whole failure mode this feature keeps guarding
    // against.
    assert.throws(() => monthAnchor(MAX_MONTH_OFFSET + 1, ZONE, LAST_DAY), /within/);
    assert.throws(() => monthAnchor(-MAX_MONTH_OFFSET - 1, ZONE, LAST_DAY), /within/);
    assert.throws(() => monthAnchor(1.5, ZONE, LAST_DAY), /whole number/);
    assert.throws(() => monthAnchor(NaN, ZONE, LAST_DAY), /whole number/);
  });
});

describe("reading a month key off the wire", () => {
  const LAST_DAY = Date.parse("2026-09-01T02:00:00Z"); // still 31 Aug in Chicago

  it("turns a key into an offset in the app zone", () => {
    assert.equal(monthOffsetOf("2026-08", ZONE, LAST_DAY), 0);
    assert.equal(monthOffsetOf("2026-09", ZONE, LAST_DAY), 1);
    assert.equal(monthOffsetOf("2025-12", ZONE, LAST_DAY), -8);
  });

  it("REJECTS a malformed key rather than coercing it to today", () => {
    // Falling back to the current month would answer a question the operator
    // did not ask, with nothing on screen to say so.
    for (const bad of ["", "2026", "2026-8", "26-08", "2026-08-01", "not-a-month", "2026-13", "2026-00"]) {
      assert.throws(() => monthOffsetOf(bad, ZONE, LAST_DAY), /month/, bad);
    }
  });

  it("REJECTS a key beyond the paging bound", () => {
    assert.throws(() => monthOffsetOf("2999-01", ZONE, LAST_DAY), /months from now/);
    assert.throws(() => monthOffsetOf("1900-01", ZONE, LAST_DAY), /months from now/);
  });

  it("round-trips with monthAnchor over the whole paging range", () => {
    for (let n = -MAX_MONTH_OFFSET; n <= MAX_MONTH_OFFSET; n++) {
      const anchor = monthAnchor(n, ZONE, LAST_DAY);
      const p = zonedPartsOf(anchor);
      const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
      assert.equal(monthOffsetOf(key, ZONE, LAST_DAY), n, key);
    }
  });
});

/** The anchor's own year/month, read back the way the server would. */
function zonedPartsOf(iso: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month") };
}
