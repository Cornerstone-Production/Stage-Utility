// service-pacing.test.ts — pure math, no DOM/CSS involved (servicePacing takes a
// plain ServiceTimeline and returns a number), so this is fully covered by a unit
// test; nothing here needs a browser.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { servicePacing } from "./service-pacing.js";

function item(overrides: Partial<ServiceTimelineItem> & Pick<ServiceTimelineItem, "itemId" | "startedAt">): ServiceTimelineItem {
  return {
    title: overrides.itemId,
    sequence: 0,
    plannedLengthSec: null,
    endedAt: null,
    actualDurationSec: null,
    ...overrides,
  };
}

function tl(items: ServiceTimelineItem[], pacingResetAt: string | null = null): ServiceTimeline {
  return {
    serviceKey: "st:plan:11am",
    serviceTypeId: "st",
    planId: "plan",
    planTitle: "Weekend",
    seriesTitle: null,
    serviceDate: "2026-09-06",
    serviceTimeId: null,
    serviceTimeStartsAt: null,
    startedAt: items[0]?.startedAt ?? "2026-09-06T12:57:57.000Z",
    endedAt: null,
    pacingResetAt,
    items,
  };
}

describe("servicePacing", () => {
  it("null timeline -> null delta", () => {
    assert.deepEqual(servicePacing(null, Date.now()), { deltaSec: null });
  });

  it("no live item -> null delta (nothing to anchor the baseline)", () => {
    const record = tl([
      item({ itemId: "a", startedAt: "2026-09-06T12:00:00.000Z", endedAt: "2026-09-06T12:01:00.000Z", plannedLengthSec: 60, actualDurationSec: 60 }),
    ]);
    assert.deepEqual(servicePacing(record, Date.now()), { deltaSec: null });
  });

  // The incident, reproduced: BENEDICTION had been live in PCO since Thursday —
  // now carried over as a not-counted item per the recorder fix — followed by a
  // real live item. Without a reset, a counted leftover would blow the delta out
  // to day-scale; WITH the recorder fix it is already not-counted, so this test
  // instead proves the widget math itself: a first counted item far in the past
  // (as if the carry-over clamp were absent, or a record legitimately spans a
  // very long first item) drives the delta into days, and a reset at the live
  // item's own start recovers a sane delta.
  it("first counted item two days old drives the delta into days; a reset at the live item's start recovers a sane one", () => {
    const dayOldStart = "2026-09-04T01:43:18.000Z"; // "Thursday"
    const liveStart = "2026-09-06T13:00:00.000Z";
    const serverNow = Date.parse("2026-09-06T13:01:00.000Z"); // 60s into the live item

    const withoutReset = tl([
      item({ itemId: "benediction", startedAt: dayOldStart, endedAt: dayOldStart, plannedLengthSec: 90, actualDurationSec: 0 }),
      item({ itemId: "live", startedAt: liveStart, plannedLengthSec: 90 }),
    ]);
    const { deltaSec: noResetDelta } = servicePacing(withoutReset, serverNow);
    assert.ok(noResetDelta != null && noResetDelta > 86_400, `expected a day-scale delta, got ${noResetDelta}`);

    const withReset = tl(
      [
        item({ itemId: "benediction", startedAt: dayOldStart, endedAt: dayOldStart, plannedLengthSec: 90, actualDurationSec: 0 }),
        item({ itemId: "live", startedAt: liveStart, plannedLengthSec: 90 }),
      ],
      liveStart,
    );
    const { deltaSec: resetDelta } = servicePacing(withReset, serverNow);
    // 60s elapsed into a 90s-planned live item, baseline moved to the live
    // item's own start -> delta is exactly the live item's own overrun (none
    // yet: 60s < 90s planned, so still "ahead"/on-plan), nowhere near a day.
    assert.ok(resetDelta != null && Math.abs(resetDelta) < 120, `expected a sane (~seconds) delta, got ${resetDelta}`);
  });

  it("reset rule: an item that ENDED before the reset is excluded, and the baseline moves to the reset", () => {
    const serverNow = Date.parse("2026-09-06T13:05:00.000Z");
    const record = tl(
      [
        item({ itemId: "welcome", startedAt: "2026-09-06T12:57:00.000Z", endedAt: "2026-09-06T13:00:00.000Z", plannedLengthSec: 60, actualDurationSec: 180 }),
        item({ itemId: "worship", startedAt: "2026-09-06T13:00:00.000Z", plannedLengthSec: 300 }),
      ],
      "2026-09-06T13:00:00.000Z", // reset right when worship started
    );
    const { deltaSec } = servicePacing(record, serverNow);
    // Only "worship" counts: 5 minutes elapsed (300s) against a 300s plan ->
    // dead on plan, delta ~0. If the excluded "welcome" item (120s over plan)
    // still counted, delta would be ~120s behind instead.
    assert.ok(deltaSec != null && Math.abs(deltaSec) < 1, `expected ~0, got ${deltaSec}`);
  });

  it("reset rule: an item still LIVE at reset time is kept, with elapsed measured from the reset instant", () => {
    const serverNow = Date.parse("2026-09-06T13:03:00.000Z");
    const record = tl(
      [
        // Live item started 13:00, planned 120s (would run out at 13:02) — but
        // pacing is reset at 13:01, 60s into it.
        item({ itemId: "long-welcome", startedAt: "2026-09-06T13:00:00.000Z", plannedLengthSec: 120 }),
      ],
      "2026-09-06T13:01:00.000Z",
    );
    const { deltaSec } = servicePacing(record, serverNow);
    // Elapsed since the reset: 120s (13:01 -> 13:03), capped at the 120s plan.
    // Baseline start is also the reset instant, so actual elapsed since
    // baseline is the same 120s -> delta ~0, not the ~180s it would be if the
    // item had been dropped entirely (deltaSec === null) or measured from its
    // own (pre-reset) start.
    assert.ok(deltaSec != null, "the live item must not be dropped by the reset");
    assert.ok(Math.abs(deltaSec) < 1, `expected ~0 (elapsed clamped to the reset instant), got ${deltaSec}`);
  });

  it("pacingResetAt null is byte-identical to the pre-extraction widget math for a normal service", () => {
    // Hand-computed fixture: doors -> welcome (planned 120, actual 130) ->
    // worship (planned 600, actual 590) -> live sermon (planned 1500, 400s in).
    const record = tl([
      item({ itemId: "welcome", startedAt: "2026-09-06T10:58:00.000Z", endedAt: "2026-09-06T11:00:10.000Z", plannedLengthSec: 120, actualDurationSec: 130 }),
      item({ itemId: "worship", startedAt: "2026-09-06T11:00:10.000Z", endedAt: "2026-09-06T11:09:40.000Z", plannedLengthSec: 600, actualDurationSec: 590 }),
      item({ itemId: "sermon", startedAt: "2026-09-06T11:09:40.000Z", plannedLengthSec: 1500 }),
    ]);
    const serverNow = Date.parse("2026-09-06T11:09:40.000Z") + 400_000; // 400s into the sermon
    const { deltaSec } = servicePacing(record, serverNow);
    // Hand math: startMs = welcome's start (10:58:00). Wall-clock elapsed to
    // "now" (11:16:20) is 1100s. plannedElapsed = 120 (welcome) + 600 (worship)
    // + min(400, 1500) (sermon, uncapped) = 1120. delta = 1100 - 1120 = -20 —
    // 20s AHEAD, matching the 10s welcome overrun (+10) and 10s worship
    // underrun (-10) netting to the widget's original figure.
    assert.equal(deltaSec, -20);
  });
});
