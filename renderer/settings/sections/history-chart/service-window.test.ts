// service-window.test.ts — one answer for both charts.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { serviceWindowOf } from "./service-window.js";

const at = (hhmm: string) => `2026-09-17T${hhmm}:00.000Z`;

const TIMELINE = {
  items: [
    { startedAt: at("19:50"), endedAt: at("20:15"), preService: true }, // Doors
    { startedAt: at("20:15"), endedAt: at("20:25"), preService: true }, // 10 min Warning
    { startedAt: at("20:25"), endedAt: at("20:36"), preService: false }, // VIDEO: Pre-roll
    { startedAt: at("20:36"), endedAt: at("21:32"), preService: false },
  ],
};

describe("serviceWindowOf", () => {
  test("the service starts at the first item that is NOT pre-service", () => {
    // Not at the recording's start. SPL recording begins at the first plan item,
    // which is usually "Doors", so passing that as the service start meant the
    // window began where the chart began and the hatch never drew.
    const w = serviceWindowOf({ timeline: TIMELINE, attendance: { serviceStartedAt: at("20:20"), endedAt: at("21:40") } });
    assert.equal(w.startedAt, at("20:25"));
  });

  test("the end is the attendance record's taper boundary when there is one", () => {
    const w = serviceWindowOf({ timeline: TIMELINE, attendance: { serviceStartedAt: null, endedAt: at("21:40") } });
    assert.equal(w.endedAt, at("21:40"));
  });

  test("with no attendance record the last item to have ENDED is the end", () => {
    const w = serviceWindowOf({ timeline: TIMELINE });
    assert.equal(w.endedAt, at("21:32"));
  });

  test("a service with an item still live has no end yet, so nothing is hatched as after it", () => {
    // The last item to have ENDED is the one before the live one, so taking it
    // as the end hatched the whole live item (the message, mid-service) as
    // "after the service".
    const live = { items: [...TIMELINE.items.slice(0, 3), { startedAt: at("20:36"), endedAt: null, preService: false }] };
    assert.equal(serviceWindowOf({ timeline: live }).endedAt, null);
    // A live attendance record (endedAt still null) must not fall back to the items.
    assert.equal(serviceWindowOf({ timeline: live, attendance: { serviceStartedAt: at("20:20"), endedAt: null } }).endedAt, null);
  });

  test("a closed record with an item left open still ends at its last ended item", () => {
    // A recorder that never closed the last item is not a live service: once the
    // record itself has ended, the taper is still hatched.
    const items = [...TIMELINE.items.slice(0, 3), { startedAt: at("20:36"), endedAt: null, preService: false }];
    assert.equal(serviceWindowOf({ timeline: { endedAt: at("21:40"), items } }).endedAt, at("20:36"));
  });

  test("a live pre-service item does not hold back a finished service's end", () => {
    // Only an IN-service item still running means the service is still on.
    const items = [...TIMELINE.items, { startedAt: at("21:32"), endedAt: null, preService: true }];
    assert.equal(serviceWindowOf({ timeline: { items } }).endedAt, at("21:32"));
  });

  test("attendance alone still gives a start, for a service whose timeline has not opened", () => {
    const w = serviceWindowOf({ attendance: { serviceStartedAt: at("20:00"), endedAt: null } });
    assert.deepEqual(w, { startedAt: at("20:00"), endedAt: null });
  });

  test("a timeline of nothing but pre-service items has no start yet", () => {
    const w = serviceWindowOf({ timeline: { items: TIMELINE.items.slice(0, 2) } });
    assert.equal(w.startedAt, null);
  });

  test("nothing at all is two nulls, not a guess", () => {
    assert.deepEqual(serviceWindowOf({}), { startedAt: null, endedAt: null });
  });

  test("a window that runs backwards drops its end rather than hatching the plot", () => {
    // A mis-stamped record, or a merge that went wrong: the only in-service item
    // starts after the attendance record closed. Drawn as given, the post band
    // covers the whole plot and says the service never happened.
    const w = serviceWindowOf({
      timeline: { items: [{ startedAt: at("21:00"), endedAt: at("21:30"), preService: false }] },
      attendance: { serviceStartedAt: null, endedAt: at("20:00") },
    });
    assert.equal(w.startedAt, at("21:00"));
    assert.equal(w.endedAt, null);
  });

  test("an item with no start is not the service's start", () => {
    const w = serviceWindowOf({
      timeline: { items: [{ startedAt: "", endedAt: at("20:30"), preService: false }, ...TIMELINE.items.slice(2)] },
    });
    assert.equal(w.startedAt, at("20:25"));
  });
});
