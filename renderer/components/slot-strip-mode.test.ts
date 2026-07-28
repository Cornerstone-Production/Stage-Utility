// Which of the two pills a slot shows. Pulled out of slot-panel so the rule is
// testable without a DOM. The regression this guards: a label on a LIVE device
// used to suppress the whole strip, taking RF bars and battery with it.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { slotStripMode } from "./slot-strip-mode.js";
import type { SlotDevice } from "../../main/types/stage.js";

function device(over: Partial<SlotDevice> = {}): SlotDevice {
  return {
    status: "ok", rf: 4, battery: 80, freq: "574.000 MHz",
    audioLevel: null, charge: 80, iemCharge: null, label: null, iemLabel: null,
    ...over,
  };
}

describe("slotStripMode", () => {
  test("a live device shows the telemetry strip", () => {
    assert.equal(slotStripMode(device()), "strip");
  });

  test("a live device with a label STILL shows the strip", () => {
    // The regression. The label replaces the frequency inside the strip; it must
    // not replace the strip.
    assert.equal(slotStripMode(device({ label: "VOX 3" })), "strip");
  });

  test("a live device with both labels still shows the strip", () => {
    assert.equal(slotStripMode(device({ label: "VOX 3", iemLabel: "IEM 2" })), "strip");
  });

  test("an offline device with a label shows the offline pill", () => {
    assert.equal(slotStripMode(device({ status: "error", rf: null, battery: null, charge: null, label: "VOX 3" })), "pill");
  });

  test("an offline device with only an IEM label shows the pill", () => {
    assert.equal(slotStripMode(device({ status: "error", rf: null, battery: null, charge: null, iemLabel: "IEM 2" })), "pill");
  });

  test("a warn-state device is still live", () => {
    assert.equal(slotStripMode(device({ status: "warn", battery: 15, charge: 15 })), "strip");
  });

  test("no device and no labels shows nothing", () => {
    assert.equal(slotStripMode(device({ status: "none", rf: null, battery: null, freq: null, charge: null })), "none");
  });

  test("hideRf still shows the strip when there is a charge level", () => {
    assert.equal(slotStripMode(device(), true), "strip");
  });

  test("hideRf with nothing else to show renders nothing", () => {
    assert.equal(slotStripMode(device({ status: "none", rf: null, battery: null, freq: null, charge: null }), true), "none");
  });

  test("an offline device with no labels at all shows nothing", () => {
    // Device bound but unreachable, nothing manually labelled — the cell stays bare
    // rather than rendering an empty pill.
    assert.equal(slotStripMode(device({ status: "error", rf: null, battery: null, charge: null })), "none");
  });
});
