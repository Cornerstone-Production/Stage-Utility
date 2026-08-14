// A provider must actually POPULATE the telemetry it emits, not merely declare it.
//
// Three hand-copies of one channel struct existed, and the Spectera copy had lost
// rfLevelDbm, charging, cycles, health and tempC. The give-away is that all five
// were still present in the emitted payload, pinned to null — so the type checker
// was satisfied and nothing failed. Telemetry had been added to two of the three
// copies and the third went on reporting dashes.
//
// The first version of this test matched source text and could not catch that: an
// interface declaring `rfLevelDbm: number | null` satisfied it, and deleting the
// line that assigns the value left it green. So this drives the real parse path
// and asserts the value that comes out — the only formulation that can express
// "populated".

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceStatus } from "../../types/devices.js";
import { SennheiserSpectera } from "./sennheiser-spectera.js";

/** Fields that must survive parse → emit when the device reports them. */
const TELEMETRY = ["rfLevelDbm", "charging", "cycles", "health", "tempC"] as const;

/** One SSCv2-shaped channel payload carrying every field. */
const FULL_PAYLOAD = {
  name: "Pack 1",
  state: "Connected",
  battery: { gauge: 76, charging: true, cycles: 143, health: 92, temperature: 31 },
  rf: { quality: 80, level: -42, frequency: 550.125 },
  audio: { level: -18 },
};

function emitFor(payload: unknown): DeviceStatus {
  const provider = new SennheiserSpectera();
  const seen: DeviceStatus[] = [];
  provider.onStatus((s) => seen.push(s));
  (provider as unknown as { updateSek(uid: string, v: unknown): void }).updateSek("ch-1", payload);
  assert.equal(seen.length, 1, "expected exactly one status emit");
  return seen[0]!;
}

describe("Spectera telemetry actually reaches the emitted status", () => {
  const status = emitFor(FULL_PAYLOAD);

  for (const field of TELEMETRY) {
    it(`populates ${field} rather than emitting null`, () => {
      assert.notEqual(
        status[field],
        null,
        `${field} is null despite the device reporting it — the parser never assigns it`,
      );
    });
  }

  it("carries the values through unchanged", () => {
    assert.equal(status.rfLevelDbm, -42);
    assert.equal(status.charging, true);
    assert.equal(status.cycles, 143);
    assert.equal(status.health, 92);
    assert.equal(status.tempC, 31);
  });

  it("still reports null for a device that says nothing", () => {
    // The honest dash. A field absent from the payload must not become a zero.
    const bare = emitFor({ name: "Pack 2", state: "Connected" });
    for (const field of TELEMETRY) assert.equal(bare[field], null, `${field} invented a value`);
  });

  it("refuses an implausible RF level rather than rendering it", () => {
    // `rssi` is a 0-100 scalar on plenty of gear; "+72 dBm" is impossible and
    // worse than the dash it would replace.
    assert.equal(emitFor({ state: "Connected", rssi: 72 }).rfLevelDbm, null);
    assert.equal(emitFor({ state: "Connected", rssi: -55 }).rfLevelDbm, -55);
  });

  it("refuses a temperature that is plainly not degrees C", () => {
    assert.equal(emitFor({ state: "Connected", temperature: 304 }).tempC, null); // Kelvin
    assert.equal(emitFor({ state: "Connected", temperature: 28 }).tempC, 28);
  });
});
