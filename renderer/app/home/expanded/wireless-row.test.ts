// The wireless panel's dot and the attention list judge a battery by one rule.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { wirelessRow } from "./bodies.js";
import { LOW_BATTERY_PERCENT } from "../attention/sources/wireless-battery.js";
import { mic } from "../attention/test-input.js";

test("a pack at exactly the low line is drawn as a problem, as the attention list lists it", () => {
  const row = wirelessRow(mic("c1", { battery: LOW_BATTERY_PERCENT }));
  assert.equal(row.tone, "bad");
});

test("a pack above it is fine", () => {
  assert.equal(wirelessRow(mic("c1", { battery: LOW_BATTERY_PERCENT + 1 })).tone, "ok");
});
