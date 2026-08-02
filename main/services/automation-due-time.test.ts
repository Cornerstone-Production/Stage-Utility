import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dueAt } from "./automation-due-time.js";

const ITEM = "2026-08-09T14:30:00Z";
const START = "2026-08-09T14:00:00Z";

describe("dueAt", () => {
  it("uses the item's own time when anchored to the item", () => {
    const t = dueAt({ anchor: "item", itemTimeIso: ITEM, serviceStartIso: START, offsetMinutes: 0 });
    assert.equal(t, Date.parse(ITEM));
  });

  it("uses the service start when anchored to it", () => {
    const t = dueAt({ anchor: "service-start", itemTimeIso: ITEM, serviceStartIso: START, offsetMinutes: 0 });
    assert.equal(t, Date.parse(START));
  });

  it("applies a negative offset to fire early", () => {
    const t = dueAt({ anchor: "item", itemTimeIso: ITEM, serviceStartIso: null, offsetMinutes: -5 });
    assert.equal(t, Date.parse(ITEM) - 5 * 60_000);
  });

  it("applies a positive offset to fire late", () => {
    const t = dueAt({ anchor: "service-start", itemTimeIso: null, serviceStartIso: START, offsetMinutes: 30 });
    assert.equal(t, Date.parse(START) + 30 * 60_000);
  });

  it("returns null when the chosen anchor has no time, rather than guessing", () => {
    // Falling back to the other anchor would fire the cue at the wrong moment,
    // which is worse than not firing and saying so.
    assert.equal(dueAt({ anchor: "item", itemTimeIso: null, serviceStartIso: START, offsetMinutes: 0 }), null);
    assert.equal(dueAt({ anchor: "service-start", itemTimeIso: ITEM, serviceStartIso: null, offsetMinutes: 0 }), null);
  });

  it("returns null for an unparseable timestamp rather than NaN", () => {
    // NaN compares false against every clock check, so the rule would never fire
    // and nothing would explain why.
    assert.equal(dueAt({ anchor: "item", itemTimeIso: "not a date", serviceStartIso: null, offsetMinutes: 0 }), null);
  });
});
