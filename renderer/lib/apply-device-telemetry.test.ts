import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { StageState } from "../../main/types/stage.js";
import { applyDeviceTelemetry } from "./apply-device-telemetry.js";

const dev = (rf: number | null) => ({
  status: "ok",
  rf,
  battery: 80,
  freq: "512.100",
  audioLevel: 0.4,
  charge: 80,
  iemCharge: null,
  label: null,
  iemLabel: null,
});

function state(over: Record<string, unknown> = {}): StageState {
  return {
    slotsByView: { v1: [{ id: "s1", order: 0, device: dev(3) }, { id: "s2", order: 1, device: dev(4) }] },
    slotsByLayoutObject: { o1: [{ id: "s3", order: 0, device: dev(2) }] },
    planTitle: "unchanged",
    ...over,
  } as unknown as StageState;
}

test("telemetry lands on the matching slot", () => {
  const out = applyDeviceTelemetry(state(), { s1: dev(5) as never });
  assert.equal(out.slotsByView.v1[0].device.rf, 5);
  assert.equal(out.slotsByView.v1[1].device.rf, 4, "other slots untouched");
});

test("slots inside layout objects are updated too", () => {
  const out = applyDeviceTelemetry(state(), { s3: dev(1) as never });
  assert.equal(out.slotsByLayoutObject.o1[0].device.rf, 1);
});

test("a slot missing from the push keeps what it had", () => {
  // A partial or stale push must never blank a reading.
  const out = applyDeviceTelemetry(state(), { s1: dev(5) as never });
  assert.equal(out.slotsByView.v1[1].device.rf, 4);
  assert.equal(out.slotsByLayoutObject.o1[0].device.rf, 2);
});

test("nothing outside the slots is disturbed", () => {
  const out = applyDeviceTelemetry(state(), { s1: dev(5) as never });
  assert.equal(out.planTitle, "unchanged");
});

test("an empty push returns the very same object, so React does not re-render", () => {
  const s = state();
  assert.equal(applyDeviceTelemetry(s, {}), s);
  assert.equal(applyDeviceTelemetry(s, undefined as never), s);
});

test("a push that changes nothing returns the same object", () => {
  const s = state();
  const same = s.slotsByView.v1[0].device;
  assert.equal(applyDeviceTelemetry(s, { s1: same }), s, "identical device object is a no-op");
});

test("an unknown slot id is ignored rather than added", () => {
  const out = applyDeviceTelemetry(state(), { nope: dev(5) as never });
  assert.equal(out.slotsByView.v1.length, 2);
  assert.equal(out.slotsByLayoutObject.o1.length, 1);
});

test("the untouched view keeps its original array identity", () => {
  const s = state({
    slotsByView: {
      v1: [{ id: "s1", order: 0, device: dev(3) }],
      v2: [{ id: "s9", order: 0, device: dev(3) }],
    },
  });
  const out = applyDeviceTelemetry(s, { s1: dev(5) as never });
  assert.notEqual(out.slotsByView.v1, s.slotsByView.v1, "changed view is a new array");
  assert.equal(out.slotsByView.v2, s.slotsByView.v2, "unchanged view is not re-created");
});

test("missing slot groups do not throw", () => {
  const out = applyDeviceTelemetry({ planTitle: "x" } as never, { s1: dev(5) as never });
  assert.equal(out.planTitle, "x");
});
