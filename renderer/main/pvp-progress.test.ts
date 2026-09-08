import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { computePvpProgress, computeStillProgress, stillOnScreenSec } from "./pvp-progress.js";
import type { PvpLayerDTO } from "@main/types/pvp";

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC", lastCueUuid: "c1", nextCueName: null,
  mediaSinceAt: null,
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 10, durationSec: 20,
  ...over,
});

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);

describe("computePvpProgress", () => {
  test("at the moment of the sample it is the anchor exactly", () => {
    const p = computePvpProgress(layer(), T, AT, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 10);
    assert.equal(p.remainingSec, 10);
    assert.equal(p.fraction, 0.5);
  });

  test("it advances locally between frames, which is the whole point", () => {
    // No frame was sent for these three seconds. If this returned 10 the bar
    // would freeze between cue changes and the efficiency decision would have
    // cost the feature.
    const p = computePvpProgress(layer(), T, AT + 3000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 13);
    assert.equal(p.remainingSec, 7);
  });

  test("a slow browser clock is corrected by skew, not believed", () => {
    // Browser is 60s BEHIND the server. Without applying skew this would report
    // a minute of negative progress.
    const p = computePvpProgress(layer(), T, AT - 60_000, 60_000);
    assert.ok(p);
    assert.equal(p.elapsedSec, 10);
  });

  test("it never runs past the end, however stale the anchor", () => {
    // A display that slept through a keepalive must not draw a bar at 400%.
    const p = computePvpProgress(layer(), T, AT + 600_000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 20);
    assert.equal(p.remainingSec, 0);
    assert.equal(p.fraction, 1);
  });

  test("it never runs before the start", () => {
    const p = computePvpProgress(layer(), T, AT - 600_000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 0);
    assert.equal(p.fraction, 0);
  });

  test("a paused clip does not advance", () => {
    // rate 0 with a duration: the clip is loaded and stopped. The bar holds.
    const p = computePvpProgress(layer({ playbackRate: 0 }), T, AT + 5000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 10);
  });

  test("a still has no progress at all", () => {
    assert.equal(computePvpProgress(layer({ state: "still", durationSec: null }), T, AT, 0), null);
  });

  test("an empty layer has no progress at all", () => {
    assert.equal(
      computePvpProgress(layer({ state: "empty", anchorElapsedSec: null, durationSec: null }), T, AT, 0),
      null,
    );
  });

  test("a null or unparseable sampledAt yields no progress, never NaN", () => {
    for (const at of [null, "", "not a date"]) {
      assert.equal(computePvpProgress(layer(), at, AT, 0), null, `sampledAt ${String(at)} produced a reading`);
    }
  });

  test("a zero or negative duration yields no progress, never a divide by zero", () => {
    assert.equal(computePvpProgress(layer({ durationSec: 0 }), T, AT, 0), null);
    assert.equal(computePvpProgress(layer({ durationSec: -5 }), T, AT, 0), null);
  });
});

const STILL_SINCE = "2026-08-30T11:59:40.000Z"; // 20s before T/AT
const still = (over: Partial<PvpLayerDTO> = {}) =>
  layer({ state: "still", playbackRate: 0, anchorElapsedSec: 0, durationSec: null, mediaSinceAt: STILL_SINCE, ...over });

describe("stillOnScreenSec", () => {
  test("a still with a known arrival counts up from it", () => {
    assert.equal(stillOnScreenSec(still(), AT, 0), 20);
    assert.equal(stillOnScreenSec(still(), AT + 5000, 0), 25);
  });

  test("skew corrects it, the same way the video anchor is corrected", () => {
    assert.equal(stillOnScreenSec(still(), AT - 10_000, 10_000), 20);
  });

  test("null for anything that is not a still", () => {
    assert.equal(stillOnScreenSec(layer({ state: "video", mediaSinceAt: STILL_SINCE }), AT, 0), null);
    assert.equal(stillOnScreenSec(layer({ state: "empty", mediaSinceAt: null }), AT, 0), null);
  });

  test("null when PVP has not told us an arrival time yet", () => {
    assert.equal(stillOnScreenSec(still({ mediaSinceAt: null }), AT, 0), null);
  });
});

describe("computeStillProgress", () => {
  test("a hold from the PVP integration card counts a still down", () => {
    const p = computeStillProgress(still(), AT, 0, 20);
    assert.ok(p);
    assert.equal(p.elapsedSec, 20);
    assert.equal(p.remainingSec, 0);
    assert.equal(p.fraction, 1);
  });

  test("THE GUARD: a widget's own hold overrides the card default, not the other way round", () => {
    // The rule this whole feature turns on: the same still is 20s into a
    // 20-second card default (nothing left) and 5s into a 30-second widget
    // override (25s left) — the two holds cannot agree on the answer, so this
    // fails if the widget's own number is ever ignored in favour of the card's.
    const halfway = computeStillProgress(still(), AT, 0, 30);
    assert.ok(halfway);
    assert.equal(halfway.remainingSec, 10);
    assert.notEqual(halfway.remainingSec, computeStillProgress(still(), AT, 0, 20)?.remainingSec);
  });

  test("remaining clamps at 0 rather than going negative", () => {
    const p = computeStillProgress(still(), AT + 60_000, 0, 20);
    assert.ok(p);
    assert.equal(p.remainingSec, 0);
    assert.equal(p.elapsedSec, 20);
    assert.equal(p.fraction, 1);
  });

  test("no hold configured (null or non-positive) yields no progress", () => {
    assert.equal(computeStillProgress(still(), AT, 0, null), null);
    assert.equal(computeStillProgress(still(), AT, 0, 0), null);
    assert.equal(computeStillProgress(still(), AT, 0, -5), null);
  });

  test("no mediaSinceAt yields no progress, whatever the hold", () => {
    assert.equal(computeStillProgress(still({ mediaSinceAt: null }), AT, 0, 20), null);
  });

  test("a video layer never gets a still's progress", () => {
    assert.equal(computeStillProgress(layer(), AT, 0, 20), null);
  });
});
