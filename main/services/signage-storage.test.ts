// The disk figures behind the storage bar.
//
// Signage is the only part of this app that can fill a disk, and when a card
// fills what stops working is not just uploading — the server cannot write the
// stores that hold the schedules either. So the pressure thresholds are worth
// pinning, and so is the arithmetic that must never draw a negative segment.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { CRITICAL_SPACE_BYTES, LOW_SPACE_BYTES, storagePressure } from "./signage-storage.js";

const GB = 1024 * 1024 * 1024;

describe("how worried to be", () => {
  test("plenty of room is ok", () => {
    assert.equal(storagePressure({ free: 20 * GB }), "ok");
  });

  test("under the low mark says so before an upload fails", () => {
    // The point is to warn BEFORE, not to report afterwards.
    assert.equal(storagePressure({ free: LOW_SPACE_BYTES - 1 }), "low");
    assert.equal(storagePressure({ free: LOW_SPACE_BYTES }), "low");
  });

  test("critical is critical, not merely low", () => {
    assert.equal(storagePressure({ free: CRITICAL_SPACE_BYTES }), "critical");
    assert.equal(storagePressure({ free: 0 }), "critical");
  });

  test("the thresholds are the right way round", () => {
    // A transposition here would report "critical" for a healthy disk and "ok"
    // for a full one, which is worse than not warning at all.
    assert.ok(CRITICAL_SPACE_BYTES < LOW_SPACE_BYTES);
  });

  test("exactly at the boundary is the WORSE of the two readings", () => {
    // Rounding a boundary towards "fine" is how a warning arrives late.
    assert.equal(storagePressure({ free: LOW_SPACE_BYTES }), "low");
    assert.equal(storagePressure({ free: LOW_SPACE_BYTES + 1 }), "ok");
  });
});
