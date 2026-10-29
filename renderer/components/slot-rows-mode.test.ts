// Which rows a slot shows. Pulled out of slot-panel so the rule is
// testable without a DOM. The regression this guards: a label on a LIVE device
// used to suppress every row, taking RF bars and battery with it.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { slotRowsMode } from "./slot-rows-mode.js";
import type { SlotDevice } from "../../main/types/stage.js";

function device(over: Partial<SlotDevice> = {}): SlotDevice {
  return {
    status: "ok", rf: 4, battery: 80, freq: "574.000 MHz",
    audioLevel: null, charge: 80, iemCharge: null, label: null, iemLabel: null,
    ...over,
  };
}

describe("slotRowsMode", () => {
  test("a live device shows the telemetry rows", () => {
    assert.equal(slotRowsMode(device()), "live");
  });

  test("a live device with a label STILL shows the live rows", () => {
    // The regression. The label replaces the frequency inside the rows; it must
    // not replace them.
    assert.equal(slotRowsMode(device({ label: "VOX 3" })), "live");
  });

  test("a live device with both labels still shows the live rows", () => {
    assert.equal(slotRowsMode(device({ label: "VOX 3", iemLabel: "IEM 2" })), "live");
  });

  test("an offline device with a label shows the offline row", () => {
    assert.equal(slotRowsMode(device({ status: "error", rf: null, battery: null, charge: null, label: "VOX 3" })), "offline");
  });

  test("an offline device with only an IEM label shows the offline row", () => {
    assert.equal(slotRowsMode(device({ status: "error", rf: null, battery: null, charge: null, iemLabel: "IEM 2" })), "offline");
  });

  test("a warn-state device is still live", () => {
    assert.equal(slotRowsMode(device({ status: "warn", battery: 15, charge: 15 })), "live");
  });

  test("no device and no labels shows nothing", () => {
    assert.equal(slotRowsMode(device({ status: "none", rf: null, battery: null, freq: null, charge: null })), "none");
  });

  test("hideRf still shows the live rows when there is a charge level", () => {
    assert.equal(slotRowsMode(device(), true), "live");
  });

  test("hideRf with nothing else to show renders nothing", () => {
    assert.equal(slotRowsMode(device({ status: "none", rf: null, battery: null, freq: null, charge: null }), true), "none");
  });

  test("an offline device with no labels at all shows nothing", () => {
    // Device bound but unreachable, nothing manually labeled — the cell stays bare
    // rather than rendering an empty row.
    assert.equal(slotRowsMode(device({ status: "error", rf: null, battery: null, charge: null })), "none");
  });
});
