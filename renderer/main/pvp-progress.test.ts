import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { computePvpProgress } from "./pvp-progress.js";
import type { PvpLayerDTO } from "@main/types/pvp";

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
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
