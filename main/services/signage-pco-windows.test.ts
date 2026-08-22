// Turning Planning Center plan times into a window a schedule can open on.
//
// Two things here are worth more than the rest.
//
// Only SERVICE times define the window. A 7am rehearsal counted as a start would
// open the foyer TVs two hours before anyone is in the building, and the
// operator would have no way to see why from the schedule row.
//
// And an unreachable PCO keeps the last known windows rather than reporting
// none. Failing closed means dark foyer screens on a Sunday because an API call
// timed out — the staleness is surfaced in the UI instead, which is a thing an
// operator can act on.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { mergeKeepingLastKnown, windowFromPlanTimes } from "./signage-pco-windows.js";

const TZ = "America/Chicago";
const at = (iso: string) => Date.parse(iso);

const times = [
  { type: "service", startsAt: "2026-08-23T14:00:00Z", endsAt: null },
  { type: "service", startsAt: "2026-08-23T16:00:00Z", endsAt: null },
  { type: "rehearsal", startsAt: "2026-08-23T12:00:00Z", endsAt: null },
];

describe("turning plan times into a window", () => {
  test("spans the FIRST service time minus lead to the LAST plus trail", () => {
    const w = windowFromPlanTimes("st-1", times, 60, 30, TZ, "2026-08-23");
    assert.equal(w?.from, at("2026-08-23T13:00:00Z"));
    assert.equal(w?.to, at("2026-08-23T16:30:00Z"));
    assert.equal(w?.fresh, true);
  });

  test("ignores rehearsals — only service times define the window", () => {
    const w = windowFromPlanTimes("st-1", times, 0, 0, TZ, "2026-08-23");
    assert.equal(w?.from, at("2026-08-23T14:00:00Z"), "a rehearsal opened the window early");
  });

  test("a single service time still makes a window", () => {
    const one = [{ type: "service", startsAt: "2026-08-23T14:00:00Z", endsAt: null }];
    const w = windowFromPlanTimes("st-1", one, 60, 30, TZ, "2026-08-23");
    assert.equal(w?.from, at("2026-08-23T13:00:00Z"));
    assert.equal(w?.to, at("2026-08-23T14:30:00Z"));
  });

  test("no service times at all is no window, not a zero-length one", () => {
    const w = windowFromPlanTimes("st-1", [times[2]], 60, 30, TZ, "2026-08-23");
    assert.equal(w, null);
  });

  test("an empty list is no window", () => {
    assert.equal(windowFromPlanTimes("st-1", [], 60, 30, TZ, "2026-08-23"), null);
  });

  test("an unparseable time is skipped rather than poisoning the window", () => {
    // One bad row from the API must not take out the whole window; NaN would
    // propagate through the min/max and produce a window nothing matches.
    const mixed = [
      { type: "service", startsAt: "not a date", endsAt: null },
      { type: "service", startsAt: "2026-08-23T14:00:00Z", endsAt: null },
    ];
    const w = windowFromPlanTimes("st-1", mixed, 0, 0, TZ, "2026-08-23");
    assert.equal(w?.from, at("2026-08-23T14:00:00Z"));
    assert.ok(Number.isFinite(w?.to));
  });

  test("only counts times on the LOCAL day asked for", () => {
    // Saturday-evening and Sunday-morning services are different days locally,
    // and merging them would hold the window open all night.
    const across = [
      { type: "service", startsAt: "2026-08-23T01:00:00Z", endsAt: null }, // Sat 20:00 CDT
      { type: "service", startsAt: "2026-08-23T14:00:00Z", endsAt: null }, // Sun 09:00 CDT
    ];
    const sunday = windowFromPlanTimes("st-1", across, 0, 0, TZ, "2026-08-23");
    assert.equal(sunday?.from, at("2026-08-23T14:00:00Z"), "a Saturday service leaked into Sunday");
    const saturday = windowFromPlanTimes("st-1", across, 0, 0, TZ, "2026-08-22");
    assert.equal(saturday?.from, at("2026-08-23T01:00:00Z"));
  });

  test("carries the service type it belongs to", () => {
    assert.equal(windowFromPlanTimes("st-9", times, 0, 0, TZ, "2026-08-23")?.serviceTypeId, "st-9");
  });
});

describe("when PCO cannot be reached", () => {
  const known = [{ serviceTypeId: "st-1", from: 1, to: 2, fresh: true }];

  test("KEEPS the last known windows rather than going dark", () => {
    const after = mergeKeepingLastKnown(known, null);
    assert.equal(after.length, 1);
    assert.equal(after[0].from, 1);
  });

  test("and marks them stale, so the UI can say so", () => {
    assert.equal(mergeKeepingLastKnown(known, null)[0].fresh, false);
  });

  test("a successful refresh replaces them and marks them fresh", () => {
    const after = mergeKeepingLastKnown([{ ...known[0], fresh: false }], [
      { serviceTypeId: "st-1", from: 5, to: 6, fresh: true },
    ]);
    assert.equal(after[0].from, 5);
    assert.equal(after[0].fresh, true);
  });

  test("a successful refresh that found NOTHING really does clear them", () => {
    // Distinct from a failure. An empty result means "no services today", and
    // holding yesterday's window would light the screens on a Tuesday.
    assert.deepEqual(mergeKeepingLastKnown(known, []), []);
  });

  test("keeping stale windows twice does not un-stale them", () => {
    const once = mergeKeepingLastKnown(known, null);
    assert.equal(mergeKeepingLastKnown(once, null)[0].fresh, false);
  });
});
