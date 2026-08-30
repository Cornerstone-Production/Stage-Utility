// What this file guards.
//
// A REFRESH THAT FINDS NOTHING NEW BROADCASTS NOTHING. This is the whole reason
// the calendar moved from a per-client poll to a pushed channel: the data changes
// maybe twice a week, and a frame every three minutes to every tile of a nine-tile
// multiview is the arithmetic the house SSE rule exists to prevent.
//
// The failure is not hypothetical and not obvious. It arrives two ways:
//
//   - a per-fetch value in the payload (fetchedAt, requestId, duration) makes
//     every refresh look like a change while every other test stays green;
//   - a SHALLOW compare over a payload whose `days` is a fresh array each build
//     sees a new reference every time and does the same thing from the other
//     direction, which is why this does not use StatusIntegration.emitIfChanged.
//
// Proven red in the session that wrote it: a fetch timestamp was added to the
// grid and the no-change test emitted a frame.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CalendarGrid } from "../types/calendar.js";
import type { View } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cal-cast-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { calendarBroadcaster, CALENDAR_CHANNEL } = await import("./calendar-broadcaster.js");
const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener, setSubscriberCheck } = await import("./broadcaster.js");

/** Every frame that actually went out, in order. */
let frames: { channel: string; payload: unknown }[] = [];

/** What getCalendarGrid will answer with next, by view id. */
let answer: (viewId: string | null) => CalendarGrid = () => grid([]);

/** How many times Planning Center was actually asked. */
let reads = 0;

function grid(names: string[], monthLabel = "August 2026"): CalendarGrid {
  return {
    monthLabel,
    zone: "America/Chicago",
    unplaceable: 0,
    days: Array.from({ length: 42 }, (_, i) => ({
      date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      inMonth: true,
      // Every event on the first square, so a changed list is a changed payload
      // nested two deep — which is exactly what a shallow compare cannot see.
      events:
        i === 0
          ? names.map((n) => ({
              id: n,
              name: n,
              startsAt: "2026-08-01T14:00:00Z",
              endsAt: "2026-08-01T15:00:00Z",
              allDay: false,
              location: null,
              churchCenterUrl: null,
              tags: [],
            }))
          : [],
    })),
  };
}

before(() => {
  addBroadcastListener((channel: string, payload: unknown) => {
    frames.push({ channel, payload });
  });
  // Pretend a display is watching, so the demand gate is not what makes these
  // pass — the gate has its own test below.
  setSubscriberCheck(() => true);
  // Installed ONCE. A test that swaps this out and forgets to put it back
  // leaves every later test reading a stub that ignores `answer`.
  (stageController as unknown as { getCalendarGrid: unknown }).getCalendarGrid = async (viewId: string | null) => {
    reads++;
    return answer(viewId);
  };
});

beforeEach(() => {
  frames = [];
  reads = 0;
  answer = () => grid([]);
  (stageController as unknown as { state: { views: View[] } }).state = {
    ...stageController.getState(),
    views: [{ id: "v-cal", name: "Office Calendar", kind: "calendar", createdAt: "" }] as View[],
  };
  // Each test starts from a known broadcast history.
  (calendarBroadcaster as unknown as { signature: string; latest: unknown }).signature = "";
  (calendarBroadcaster as unknown as { signature: string; latest: unknown }).latest = {};
});

describe("a frame goes out only when the grid is not what it was", () => {
  it("broadcasts the first read", async () => {
    await calendarBroadcaster.refresh();
    assert.equal(frames.length, 1);
    assert.equal(frames[0].channel, CALENDAR_CHANNEL);
  });

  it("broadcasts NOTHING when a refresh returns identical data", async () => {
    // THE guard. Planning Center is read on a timer; almost every read finds the
    // same month it found last time, and each of those must be silent.
    //
    // The clock is MOVED between refreshes, and that is the whole point. The
    // first version of this test ran three refreshes back to back, which took
    // under a millisecond — so when the mutation was applied (a Date.now() in
    // the broadcast payload) every refresh produced the SAME timestamp and the
    // test stayed green on the exact bug it was written for. Real refreshes are
    // three minutes apart. Anything per-fetch in the payload differs here.
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => {
      fake += 3 * 60_000;
      return fake;
    };
    try {
      await calendarBroadcaster.refresh();
      frames = [];
      await calendarBroadcaster.refresh();
      await calendarBroadcaster.refresh();
      await calendarBroadcaster.refresh();
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(frames, [], "an unchanged month was broadcast anyway");
  });

  it("broadcasts when an event is added, which a shallow compare would miss", async () => {
    // The change is two levels down — days[0].events — so this fails if the
    // change test ever becomes a shallow key compare over the grid.
    await calendarBroadcaster.refresh();
    frames = [];
    answer = () => grid(["Elders Meeting"]);
    await calendarBroadcaster.refresh();
    assert.equal(frames.length, 1);
  });

  it("broadcasts when the month rolls over", async () => {
    await calendarBroadcaster.refresh();
    frames = [];
    answer = () => grid([], "September 2026");
    await calendarBroadcaster.refresh();
    assert.equal(frames.length, 1);
  });

  it("broadcasts when a calendar view is deleted", async () => {
    await calendarBroadcaster.refresh();
    frames = [];
    (stageController as unknown as { state: { views: View[] } }).state = {
      ...stageController.getState(),
      views: [] as View[],
    };
    await calendarBroadcaster.refresh();
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].payload, {});
  });

  it("carries a grid per view, because two views can filter to two departments", async () => {
    (stageController as unknown as { state: { views: View[] } }).state = {
      ...stageController.getState(),
      views: [
        { id: "v-a", name: "A", kind: "calendar", createdAt: "" },
        { id: "v-b", name: "B", kind: "calendar", createdAt: "" },
      ] as View[],
    };
    answer = (viewId) => grid(viewId === "v-a" ? ["Alpha"] : ["Beta"]);
    await calendarBroadcaster.refresh();
    const payload = frames[0].payload as Record<string, CalendarGrid>;
    assert.deepEqual(Object.keys(payload).sort(), ["v-a", "v-b"]);
    assert.equal(payload["v-a"].days[0].events[0].name, "Alpha");
    assert.equal(payload["v-b"].days[0].events[0].name, "Beta");
  });
});

describe("reading Planning Center at all", () => {
  it("does not read when nothing is subscribed", async () => {
    // A building with no calendar on any wall must not be asking PCO every three
    // minutes on its behalf.
    setSubscriberCheck(() => false);
    await calendarBroadcaster.refresh();
    setSubscriberCheck(() => true);
    assert.equal(reads, 0);
    assert.deepEqual(frames, []);
  });

  it("reads anyway when forced, so a filter change applies at once", async () => {
    // The operator who just picked a tag is looking at the screen. Waiting up to
    // three minutes for the gate to open reads as the setting not working.
    setSubscriberCheck(() => false);
    await calendarBroadcaster.refresh(true);
    setSubscriberCheck(() => true);
    assert.equal(reads, 1);
  });
});

describe("a view that could not be read", () => {
  it("returns the failure rather than swallowing it", async () => {
    answer = () => {
      throw new Error("planning center unreachable");
    };
    const failed = await calendarBroadcaster.refresh();
    assert.equal(failed.length, 1);
    assert.equal(failed[0].viewId, "v-cal");
    assert.match(failed[0].message, /unreachable/);
  });

  it("keeps that view's last good month instead of blanking it", async () => {
    answer = () => grid(["Elders Meeting"]);
    await calendarBroadcaster.refresh();
    frames = [];
    answer = () => {
      throw new Error("planning center unreachable");
    };
    await calendarBroadcaster.refresh();
    // Unchanged, so silent — and still the good month underneath.
    assert.deepEqual(frames, []);
    assert.equal(calendarBroadcaster.getLatest()["v-cal"].days[0].events[0].name, "Elders Meeting");
  });

  it("does not let one failing view blank the others", async () => {
    (stageController as unknown as { state: { views: View[] } }).state = {
      ...stageController.getState(),
      views: [
        { id: "v-good", name: "A", kind: "calendar", createdAt: "" },
        { id: "v-bad", name: "B", kind: "calendar", createdAt: "" },
      ] as View[],
    };
    answer = (viewId) => {
      if (viewId === "v-bad") throw new Error("nope");
      return grid(["Alpha"]);
    };
    const failed = await calendarBroadcaster.refresh();
    assert.deepEqual(failed.map((f) => f.viewId), ["v-bad"]);
    assert.equal(calendarBroadcaster.getLatest()["v-good"].days[0].events[0].name, "Alpha");
  });
});
