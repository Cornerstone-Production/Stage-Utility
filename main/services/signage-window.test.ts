// Is this schedule open right now, and when could that answer next change?
//
// Every test here is written against America/Chicago with explicit UTC instants,
// because the bug this module exists to avoid is invisible in local time. The
// app runs on boxes set to UTC; a "05:00 to 13:00 on Sunday" window computed
// from a fixed offset opens an hour early for half the year, and a calendar
// comparison rolls its date at 19:00 Chicago. That once stopped every recorder
// mid-service. Everything here goes through the app time zone.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { windowActiveAt, nextBoundaryAfter, intervalsOnDay, localDayStart } from "./signage-window.js";

const TZ = "America/Chicago";
const CTX = { pcoWindows: [], liveServiceTypeId: null };
const at = (iso: string) => Date.parse(iso);

describe("an always window", () => {
  test("is open whenever you ask", () => {
    assert.equal(windowActiveAt({ kind: "always" }, at("2026-08-23T14:00:00Z"), TZ, CTX), true);
    assert.equal(windowActiveAt({ kind: "always" }, at("2026-01-01T03:00:00Z"), TZ, CTX), true);
  });

  test("and never changes, so it has no boundary", () => {
    assert.equal(nextBoundaryAfter({ kind: "always" }, at("2026-08-23T14:00:00Z"), TZ, CTX), null);
  });
});

describe("a weekly window", () => {
  const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;

  test("is open inside its hours on its day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T14:00:00Z"), TZ, CTX), true); // Sun 09:00 CDT
  });

  test("is shut on another day at the same hour", () => {
    assert.equal(windowActiveAt(w, at("2026-08-24T14:00:00Z"), TZ, CTX), false); // Mon
  });

  test("opens exactly at its start", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T10:00:00Z"), TZ, CTX), true);  // Sun 05:00
    assert.equal(windowActiveAt(w, at("2026-08-23T09:59:00Z"), TZ, CTX), false); // 04:59
  });

  test("is half-open at the end, so 13:00 is already out", () => {
    // Half-open on both this and the horizon, so no instant is inside two
    // windows and two displays cannot land on different sides of a boundary.
    assert.equal(windowActiveAt(w, at("2026-08-23T17:59:00Z"), TZ, CTX), true);  // 12:59
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, CTX), false); // 13:00
  });

  test("handles several days", () => {
    const mf = { kind: "weekly", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" } as const;
    assert.equal(windowActiveAt(mf, at("2026-08-24T15:00:00Z"), TZ, CTX), true);  // Mon 10:00
    assert.equal(windowActiveAt(mf, at("2026-08-23T15:00:00Z"), TZ, CTX), false); // Sun
    assert.equal(windowActiveAt(mf, at("2026-08-29T15:00:00Z"), TZ, CTX), false); // Sat
  });

  test("with no days at all is never open, rather than always", () => {
    // An empty list is a half-configured schedule. Treating it as "every day"
    // would put content on every wall in the building.
    const none = { kind: "weekly", days: [], start: "05:00", end: "13:00" } as const;
    assert.equal(windowActiveAt(none, at("2026-08-23T14:00:00Z"), TZ, CTX), false);
  });
});

describe("a weekly window that crosses midnight", () => {
  // 22:00-02:00 on Thursday must run into Friday morning. The day tested is the
  // day the window STARTED; testing "today" shuts it at midnight, which is the
  // obvious implementation and the wrong one.
  const w = { kind: "weekly", days: [4], start: "22:00", end: "02:00" } as const;

  test("is open before midnight on its own day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-21T04:00:00Z"), TZ, CTX), true); // Thu 23:00 CDT
  });

  test("is STILL open after midnight, on the next calendar day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-21T06:00:00Z"), TZ, CTX), true); // Fri 01:00 CDT
  });

  test("shuts at its end", () => {
    assert.equal(windowActiveAt(w, at("2026-08-21T07:00:00Z"), TZ, CTX), false); // Fri 02:00
    assert.equal(windowActiveAt(w, at("2026-08-21T08:00:00Z"), TZ, CTX), false); // Fri 03:00
  });

  test("is shut on Friday night, which is not its day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-22T04:00:00Z"), TZ, CTX), false); // Fri 23:00
  });

  test("is shut on Thursday morning, before it has started", () => {
    assert.equal(windowActiveAt(w, at("2026-08-20T14:00:00Z"), TZ, CTX), false); // Thu 09:00
  });
});

describe("windows and daylight saving", () => {
  // Local hours stay local hours across a DST change. A fixed-offset calculation
  // drifts by an hour, which is how a 05:00 window opens at 04:00 for half the
  // year - on a wall, in a foyer, before anyone is there to notice.
  const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;

  test("opens at 05:00 local in CDT (UTC-5)", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T10:00:00Z"), TZ, CTX), true);
    assert.equal(windowActiveAt(w, at("2026-08-23T09:59:00Z"), TZ, CTX), false);
  });

  test("and at 05:00 local in CST (UTC-6), an hour later in UTC", () => {
    assert.equal(windowActiveAt(w, at("2026-12-06T11:00:00Z"), TZ, CTX), true);
    assert.equal(windowActiveAt(w, at("2026-12-06T10:59:00Z"), TZ, CTX), false);
  });

  test("a UTC host does not roll the date early", () => {
    // 2026-08-24T01:00Z is Sunday 20:00 in Chicago - still Sunday locally, even
    // though the UTC date has already become Monday.
    const evening = { kind: "weekly", days: [0], start: "19:00", end: "22:00" } as const;
    assert.equal(windowActiveAt(evening, at("2026-08-24T01:00:00Z"), TZ, CTX), true);
  });
});

describe("a date range", () => {
  const w = { kind: "dates", from: "2026-12-01", to: "2026-12-25", start: "08:00", end: "20:00" } as const;

  test("includes BOTH end dates", () => {
    assert.equal(windowActiveAt(w, at("2026-12-01T18:00:00Z"), TZ, CTX), true); // Dec 1, 12:00
    assert.equal(windowActiveAt(w, at("2026-12-25T18:00:00Z"), TZ, CTX), true); // Dec 25, 12:00
  });

  test("and excludes the days either side", () => {
    assert.equal(windowActiveAt(w, at("2026-11-30T18:00:00Z"), TZ, CTX), false);
    assert.equal(windowActiveAt(w, at("2026-12-26T18:00:00Z"), TZ, CTX), false);
  });

  test("still honours its time of day", () => {
    assert.equal(windowActiveAt(w, at("2026-12-10T06:00:00Z"), TZ, CTX), false); // 00:00 local
  });

  test("can carry a weekly pattern inside the range", () => {
    const sundays = { ...w, days: [0] } as const;
    assert.equal(windowActiveAt(sundays, at("2026-12-06T18:00:00Z"), TZ, CTX), true);  // a Sunday
    assert.equal(windowActiveAt(sundays, at("2026-12-07T18:00:00Z"), TZ, CTX), false); // Monday
  });
});

describe("a one-off", () => {
  const w = { kind: "once", date: "2026-12-24", start: "15:00", end: "21:00" } as const;

  test("is open on its date, inside its hours", () => {
    assert.equal(windowActiveAt(w, at("2026-12-24T23:00:00Z"), TZ, CTX), true); // 17:00 local
  });

  test("and shut on any other date", () => {
    assert.equal(windowActiveAt(w, at("2026-12-23T23:00:00Z"), TZ, CTX), false);
    assert.equal(windowActiveAt(w, at("2026-12-25T23:00:00Z"), TZ, CTX), false);
  });
});

describe("a PCO window", () => {
  const w = {
    kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: true,
  } as const;
  const windows = [
    { serviceTypeId: "st-1", from: at("2026-08-23T13:00:00Z"), to: at("2026-08-23T17:00:00Z"), fresh: true },
  ];

  test("is open inside the precomputed window", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T15:00:00Z"), TZ, { pcoWindows: windows, liveServiceTypeId: null }), true);
  });

  test("is shut before and after it, when nothing is live", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T12:00:00Z"), TZ, { pcoWindows: windows, liveServiceTypeId: null }), false);
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, { pcoWindows: windows, liveServiceTypeId: null }), false);
  });

  test("STAYS OPEN past its end while PCO says that service type is live", () => {
    // A service running long must not blank the foyer mid-service.
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, { pcoWindows: windows, liveServiceTypeId: "st-1" }), true);
  });

  test("does NOT open early just because something is live", () => {
    // The extension holds a window open; it does not create one. Otherwise
    // stepping through next week's plan in PCO Live lights every foyer TV.
    assert.equal(windowActiveAt(w, at("2026-08-20T15:00:00Z"), TZ, { pcoWindows: windows, liveServiceTypeId: "st-1" }), false);
  });

  test("ignores a different service type being live", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, { pcoWindows: windows, liveServiceTypeId: "st-2" }), false);
  });

  test("does not extend when the operator turned extension off", () => {
    const noExt = { ...w, liveExtension: false };
    assert.equal(windowActiveAt(noExt, at("2026-08-23T18:00:00Z"), TZ, { pcoWindows: windows, liveServiceTypeId: "st-1" }), false);
  });

  test("with no windows fetched at all it is simply shut", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T15:00:00Z"), TZ, CTX), false);
  });

  test("uses a stale window rather than going dark", () => {
    // Failing closed here means dark foyer TVs on a Sunday because an API call
    // timed out. The staleness is surfaced in the UI, not acted on here.
    const stale = [{ ...windows[0], fresh: false }];
    assert.equal(windowActiveAt(w, at("2026-08-23T15:00:00Z"), TZ, { pcoWindows: stale, liveServiceTypeId: null }), true);
  });
});

describe("the next moment a window's answer could change", () => {
  test("a weekly window reports its own end while it is open", () => {
    const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;
    assert.equal(
      nextBoundaryAfter(w, at("2026-08-23T14:00:00Z"), TZ, CTX),
      at("2026-08-23T18:00:00Z"),
    );
  });

  test("and its next start while it is shut", () => {
    const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;
    assert.equal(
      nextBoundaryAfter(w, at("2026-08-24T14:00:00Z"), TZ, CTX), // Monday
      at("2026-08-30T10:00:00Z"), // the next Sunday 05:00 CDT
    );
  });

  test("crosses a DST change without drifting", () => {
    // DST ends at 02:00 on Sunday 1 November 2026, so 05:00 local THAT MORNING
    // is already CST (UTC-6), not the CDT (UTC-5) in force when the boundary is
    // computed on the Saturday. An offset captured at computation time lands an
    // hour early; this is the case that catches it.
    const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;
    assert.equal(
      nextBoundaryAfter(w, at("2026-10-31T12:00:00Z"), TZ, CTX), // Sat before the change
      at("2026-11-01T11:00:00Z"), // Sun 05:00 CST
    );
  });

  test("a window that wrapped past midnight reports its end THIS morning", () => {
    // The Thursday-night case, and it was wrong. Asked at Friday 01:00 — inside
    // a window that opened Thursday 22:00 — the search began at Friday's local
    // midnight, found no interval starting on a Friday, and answered with NEXT
    // Thursday's opening. The horizon then carried one entry for a week, so a
    // screen played Thursday night's playlist until the following Thursday.
    //
    // A wrapped window's closing edge belongs to the day it STARTED, which is
    // the day the search skipped.
    const w = { kind: "weekly", days: [4], start: "22:00", end: "02:00" } as const;
    assert.equal(
      nextBoundaryAfter(w, at("2026-08-21T06:00:00Z"), TZ, CTX), // Fri 01:00 CDT
      at("2026-08-21T07:00:00Z"), // Fri 02:00 CDT — when it shuts
    );
  });

  test("the same for a one-off that runs past midnight", () => {
    const w = { kind: "once", date: "2026-08-20", start: "22:00", end: "02:00" } as const;
    assert.equal(
      nextBoundaryAfter(w, at("2026-08-21T06:00:00Z"), TZ, CTX), // Fri 01:00 CDT
      at("2026-08-21T07:00:00Z"),
    );
  });

  test("a PCO window reports its SCHEDULED end, not a guess at when live stops", () => {
    // A live extension is not a predictable instant; the scheduler recomputes on
    // the live-state change instead of trying to time it.
    const w = {
      kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: true,
    } as const;
    const ctx = {
      pcoWindows: [{ serviceTypeId: "st-1", from: at("2026-08-23T13:00:00Z"), to: at("2026-08-23T17:00:00Z"), fresh: true }],
      liveServiceTypeId: "st-1",
    };
    assert.equal(nextBoundaryAfter(w, at("2026-08-23T15:00:00Z"), TZ, ctx), at("2026-08-23T17:00:00Z"));
  });

  test("a one-off in the past has no next boundary", () => {
    const w = { kind: "once", date: "2020-12-24", start: "15:00", end: "21:00" } as const;
    assert.equal(nextBoundaryAfter(w, at("2026-08-23T15:00:00Z"), TZ, CTX), null);
  });

  test("never returns a moment in the past", () => {
    // A boundary at or before `after` would make the scheduler busy-loop.
    const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;
    for (const t of ["2026-08-23T10:00:00Z", "2026-08-23T18:00:00Z", "2026-08-25T00:00:00Z"]) {
      const b = nextBoundaryAfter(w, at(t), TZ, CTX);
      assert.ok(b === null || b > at(t), `boundary ${b} is not after ${t}`);
    }
  });
});

describe("the intervals a calendar draws", () => {
  const dayOf = (iso: string) => localDayStart(at(iso), TZ);

  test("agrees with windowActiveAt at every quarter hour of a day", () => {
    // The point of exporting intervalsOnDay rather than working the times out
    // again in the renderer. If these two ever disagree, the calendar is a
    // picture of a schedule nobody is running — and the operator would have no
    // way to tell which one was lying.
    const windows = [
      { kind: "weekly", days: [0], start: "05:00", end: "13:00" },
      { kind: "weekly", days: [4], start: "22:00", end: "02:00" }, // wraps
      { kind: "weekly", days: [5], start: "22:00", end: "02:00" }, // wraps INTO the day under test
      { kind: "dates", from: "2026-08-20", to: "2026-08-24", days: [6], start: "09:00", end: "11:00" },
      { kind: "once", date: "2026-08-22", start: "18:00", end: "20:00" },
    ] as const;

    for (const w of windows) {
      // The last day is deliberately OUTSIDE the `dates` window's range and
      // outside the `once` date: sampling only days inside the range let a
      // version that ignored the range entirely pass this test.
      for (const dayIso of [
        "2026-08-22T12:00:00Z",
        "2026-08-23T12:00:00Z",
        "2026-08-21T12:00:00Z",
        "2026-08-29T12:00:00Z",
      ]) {
        const dayStart = dayOf(dayIso);
        const intervals = intervalsOnDay(w, dayStart, TZ, CTX);
        for (let q = 0; q < 96; q++) {
          const t = dayStart + q * 15 * 60_000;
          const drawn = intervals.some((i) => t >= i.from && t < i.to);
          assert.equal(
            drawn,
            windowActiveAt(w, t, TZ, CTX),
            `${JSON.stringify(w)} at +${q * 15}min of ${dayIso}: drawn=${drawn}`,
          );
        }
      }
    }
  });

  test("a window that started YESTERDAY still draws its tail on this day", () => {
    // Saturday 22:00 to Sunday 02:00, asked about the Sunday. Looking only at
    // today's occurrence returns nothing and the Sunday column comes up empty,
    // with the wall showing a playlist the calendar says is not on.
    const w = { kind: "weekly", days: [6], start: "22:00", end: "02:00" } as const;
    const sunday = dayOf("2026-08-23T12:00:00Z");
    const drawn = intervalsOnDay(w, sunday, TZ, CTX);
    assert.equal(drawn.length, 1);
    assert.ok(drawn[0].from < sunday, "the interval has to have started before this day");
    assert.equal(drawn[0].to, sunday + 2 * 3_600_000);
  });

  test("a PCO window is drawn only for its own service type, and only if it touches the day", () => {
    const w = { kind: "pco", serviceTypeId: "st-1", leadMinutes: 0, trailMinutes: 0, liveExtension: false } as const;
    const ctx = {
      pcoWindows: [
        { serviceTypeId: "st-1", from: at("2026-08-23T13:00:00Z"), to: at("2026-08-23T17:00:00Z"), fresh: true },
        { serviceTypeId: "st-2", from: at("2026-08-23T13:00:00Z"), to: at("2026-08-23T17:00:00Z"), fresh: true },
        { serviceTypeId: "st-1", from: at("2026-08-30T13:00:00Z"), to: at("2026-08-30T17:00:00Z"), fresh: true },
      ],
      liveServiceTypeId: null,
    };
    const drawn = intervalsOnDay(w, dayOf("2026-08-23T12:00:00Z"), TZ, ctx);
    assert.deepEqual(drawn, [{ from: at("2026-08-23T13:00:00Z"), to: at("2026-08-23T17:00:00Z") }]);
  });

  test("an always window fills exactly one local day, DST included", () => {
    // The spring-forward Sunday is 23 hours long. A hard-coded +24h would run
    // the block an hour into the Monday column.
    const day = dayOf("2026-03-08T12:00:00Z");
    const [iv] = intervalsOnDay({ kind: "always" }, day, TZ, CTX);
    assert.equal(iv.from, day);
    assert.equal(iv.to - iv.from, 23 * 3_600_000);
  });
});
