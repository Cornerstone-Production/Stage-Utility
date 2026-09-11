// Shure has no valid/invalid flag. A field that cannot answer sends a code at the
// top of its own range, and every driver here had hand-rolled its own comparison
// against a remembered one — `=== 255` in three places, `>= 65535` in a fourth.
//
// Two of those guessed the boundary low, and a real charger walked straight under
// it. The frames below are VERBATIM from an SBC220 (FW 1.4.53) on the LAN: bay 1
// healthy and full, bay 7 faulted. The faulted bay answers BATT_CYCLE 65534 and
// BATT_TEMP_F 254 — one below each guard — so a display with cycles and
// temperature switched on rendered "65534 cyc" and "123°C" beside a bay whose
// battery had failed.
//
// So the assertion is not "the sentinel list is right". It is: feed the faulted
// bay's real dump through the real socket parser and NOTHING numeric comes out.
// A source-text scan could not express that — the old guards read perfectly well
// and were wrong by one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceStatus } from "../../types/devices.js";
import { ShureAxient } from "./shure-axient.js";
import { ShureCharger } from "./shure-charger.js";
import { ShureUlxd } from "./shure-ulxd.js";
import { batteryMinutesFrom, shureNumber } from "./shure-base.js";

/** Feed raw device bytes to a provider and collect what it emits. */
function emitsFor(provider: object, channels: number, ...frames: string[]): DeviceStatus[] {
  const seen: DeviceStatus[] = [];
  const inner = provider as {
    onStatus(cb: (s: DeviceStatus) => void): void;
    initChannelStates(count: number): void;
    handleData(chunk: string): void;
  };
  inner.onStatus((s) => seen.push(s));
  inner.initChannelStates(channels);
  for (const f of frames) inner.handleData(f);
  return seen;
}

function latest(emits: DeviceStatus[], channelId: string): DeviceStatus {
  const forChannel = emits.filter((s) => s.channelId === channelId);
  assert.ok(forChannel.length > 0, `nothing emitted for channel ${channelId}`);
  return forChannel[forChannel.length - 1]!;
}

/** One bay's slice of a real `GET 0 ALL` dump, in the order the charger sends it. */
function bayFrames(bay: number, f: Record<string, string>): string[] {
  return Object.entries(f).map(([token, value]) => `< REP ${bay} ${token} ${value} >`);
}

// Verbatim from the unit, 11 Sept 2026. Bay 1 is a healthy pack sitting full;
// bay 7 is the faulted one, and every one of its readings is a marker.
const HEALTHY_BAY = {
  BATT_DETECTED: "YES",
  BATT_TIME_TO_FULL: "65529",
  BATT_STATE: "FULL",
  BATT_CHARGE: "100",
  BATT_CYCLE: "00362",
  BATT_TEMP_F: "115",
  BATT_HEALTH: "084",
  BATT_BARS: "005",
  BATT_ERROR: "000",
};
const FAULTED_BAY = {
  BATT_DETECTED: "YES",
  BATT_TIME_TO_FULL: "65534",
  BATT_STATE: "ERROR",
  BATT_CHARGE: "254",
  BATT_CYCLE: "65534",
  BATT_TEMP_F: "254",
  BATT_HEALTH: "254",
  BATT_BARS: "254",
  BATT_ERROR: "007",
};

describe("a faulted charger bay reports nothing rather than nonsense", () => {
  const status = latest(emitsFor(new ShureCharger(), 8, ...bayFrames(7, FAULTED_BAY)), "7");

  it("BATT_CYCLE 65534 is a marker, not three hundred years of charging", () => {
    assert.equal(
      status.cycles,
      null,
      "65534 reached the display as a cycle count — the guard was `>= 65535` and the " +
        "device answers one below it",
    );
  });

  it("BATT_TEMP_F 254 is a marker, not 123°C", () => {
    assert.equal(
      status.tempC,
      null,
      "254°F was converted and rendered — the guard was `>= 255` and the device " +
        "answers one below it",
    );
  });

  it("and every other reading on that bay is a dash too", () => {
    assert.equal(status.battery, null);
    assert.equal(status.health, null);
    assert.equal(status.batteryMinutes, null);
  });
});

describe("a healthy bay's real readings survive the same guard", () => {
  // The other half of the boundary. A guard wide enough to swallow 65534 and 254
  // must not also swallow 362 cycles, 115°F or 84% health.
  const status = latest(emitsFor(new ShureCharger(), 8, ...bayFrames(1, HEALTHY_BAY)), "1");

  it("keeps the cycle count, temperature, charge and health", () => {
    assert.equal(status.cycles, 362);
    assert.equal(status.tempC, 46); // 115°F
    assert.equal(status.battery, 100);
    assert.equal(status.health, 84);
  });

  it("reads BATT_TIME_TO_FULL 65529 on a full bay as not-applicable", () => {
    // Four BELOW the lowest sentinel Shure documents, which is why the block here
    // is the top of the field's width rather than a list of three codes.
    assert.equal(status.timeToFullMinutes, null);
  });
});

describe("the same marker block on the receivers", () => {
  it("Axient TX_BATT_BARS at the top of the byte is no transmitter, not 5080%", () => {
    const status = latest(emitsFor(new ShureAxient(), 4, "< REP 1 TX_BATT_BARS 254 >"), "1");
    assert.equal(status.battery, null, "254 bars became a battery percentage");
    assert.equal(status.online, false);
  });

  it("Axient TX_BATT_CHARGE_PERCENT at the top of the byte is unknown", () => {
    const status = latest(
      emitsFor(new ShureAxient(), 4, "< REP 2 TX_BATT_CHARGE_PERCENT 254 >"),
      "2",
    );
    assert.equal(status.battery, null);
  });

  it("ULX-D BATT_BARS at the top of the byte is no TX present", () => {
    const status = latest(emitsFor(new ShureUlxd(), 4, "< REP 1 BATT_BARS 254 >"), "1");
    assert.equal(status.battery, null);
    assert.equal(status.online, false);
  });

  it("and five real bars is still five bars on both", () => {
    assert.equal(latest(emitsFor(new ShureAxient(), 4, "< REP 1 TX_BATT_BARS 005 >"), "1").battery, 100);
    assert.equal(latest(emitsFor(new ShureUlxd(), 4, "< REP 1 BATT_BARS 004 >"), "1").battery, 80);
  });
});

describe("shureNumber", () => {
  it("reserves the top eight codes of a 16-bit field", () => {
    for (const v of ["65528", "65529", "65533", "65534", "65535"]) {
      assert.equal(shureNumber(v, { width: 16 }), null, `${v} is a marker, not a value`);
    }
    assert.equal(shureNumber("65527", { width: 16 }), 65527);
  });

  it("reserves the top eight codes of a byte", () => {
    for (const v of ["248", "253", "254", "255"]) {
      assert.equal(shureNumber(v, { width: 8 }), null, `${v} is a marker, not a value`);
    }
    assert.equal(shureNumber("247", { width: 8 }), 247);
  });

  it("reads Shure's zero padding rather than tripping over it", () => {
    assert.equal(shureNumber("00362", { width: 16 }), 362);
    assert.equal(shureNumber("005", { width: 8 }), 5);
    assert.equal(shureNumber("000", { width: 8 }), 0);
  });

  it("refuses a reading outside the field's own range rather than clamping it", () => {
    // Inventing 100% for a bay that reported something impossible is worse than
    // saying nothing, which is what a clamp would have done.
    assert.equal(shureNumber("120", { width: 8, min: 0, max: 100 }), null);
    assert.equal(shureNumber("-5", { width: 16, min: 0 }), null);
  });

  it("refuses nonsense rather than passing NaN on", () => {
    assert.equal(shureNumber("UNKNOWN", { width: 8 }), null);
    assert.equal(shureNumber(undefined, { width: 16 }), null);
  });

  it("batteryMinutesFrom is the same block, named for its unit", () => {
    assert.equal(batteryMinutesFrom("00215"), 215);
    assert.equal(batteryMinutesFrom("0"), 0);
    for (const v of ["65529", "65533", "65534", "65535"]) {
      assert.equal(batteryMinutesFrom(v), null, `${v} is a marker, not a duration`);
    }
    assert.equal(batteryMinutesFrom("-5"), null);
    assert.equal(batteryMinutesFrom(undefined), null);
  });
});
