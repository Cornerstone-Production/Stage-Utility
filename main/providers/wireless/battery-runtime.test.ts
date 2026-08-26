// Battery runtime remaining has to survive the whole path: raw TCP frame →
// framing → REP parse → channel state → emitted DeviceStatus.
//
// It did not. The Axient driver carried a `BATT_RUN_TIME` case that logged a
// number and stored nothing ("not part of DeviceStatus shape"), and an AD4Q does
// not send that token anyway — it sends TX_BATT_MINS, which fell through to
// `default:` and was logged as an unrecognized field. Two independent reasons
// for the same silence.
//
// So this drives the REAL parse path from the bytes rather than calling the
// report handler with hand-made arguments: a test that asserted on
// handleReport(2, "TX_BATT_MINS", …) would have passed on a driver that never
// reaches that case, which is exactly the bug.
//
// The frames below are verbatim from a live AD4Q-A on the LAN, captured with
// SHURE_DEBUG=1 — including the zero padding, which is what makes parseInt the
// right reader and a naive Number() on a leading-zero string a trap.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceStatus } from "../../types/devices.js";
import { ShureAxient } from "./shure-axient.js";
import { ShureUlxd } from "./shure-ulxd.js";
import { batteryMinutesFrom } from "./shure-base.js";

/** Feed raw device bytes to a provider and collect what it emits. */
function emitsFor(provider: ShureAxient | ShureUlxd, ...frames: string[]): DeviceStatus[] {
  const seen: DeviceStatus[] = [];
  provider.onStatus((s) => seen.push(s));
  const inner = provider as unknown as {
    initChannelStates(count: number): void;
    handleData(chunk: string): void;
  };
  inner.initChannelStates(4);
  for (const f of frames) inner.handleData(f);
  return seen;
}

/** The last emit for a channel, which is the state the UI would render. */
function latest(emits: DeviceStatus[], channelId: string): DeviceStatus {
  const forChannel = emits.filter((s) => s.channelId === channelId);
  assert.ok(forChannel.length > 0, `nothing emitted for channel ${channelId}`);
  return forChannel[forChannel.length - 1]!;
}

describe("Shure battery runtime reaches the emitted status", () => {
  it("Axient TX_BATT_MINS — the token a real AD4Q sends", () => {
    // Channel 2 of the rack, exactly as read off the wire: 44% charge with 215
    // minutes left. The pair is the whole argument for carrying runtime at all —
    // 44% is three and a half hours on this pack and could be forty minutes on
    // another.
    const emits = emitsFor(
      new ShureAxient(),
      "< REP 2 TX_BATT_CHARGE_PERCENT 044 >",
      "< REP 2 TX_BATT_MINS 00215 >",
    );
    const status = latest(emits, "2");
    assert.equal(status.battery, 44);
    assert.equal(
      status.batteryMinutes,
      215,
      "TX_BATT_MINS never reached the emitted status — the driver dropped it as an unrecognized field",
    );
  });

  it("Axient BATT_RUN_TIME — the token Shure's own AD docs name", () => {
    const status = latest(emitsFor(new ShureAxient(), "< REP 3 BATT_RUN_TIME 00090 >"), "3");
    assert.equal(status.batteryMinutes, 90);
  });

  it("ULX-D BATT_RUN_TIME", () => {
    const status = latest(emitsFor(new ShureUlxd(), "< REP 1 BATT_RUN_TIME 00135 >"), "1");
    assert.equal(status.batteryMinutes, 135);
  });

  it("65535 is 'unknown', not a battery with forty-five days left", () => {
    // Also verbatim: an empty channel reports 65535 on every poll.
    const status = latest(emitsFor(new ShureAxient(), "< REP 1 TX_BATT_MINS 65535 >"), "1");
    assert.equal(status.batteryMinutes, null);
  });

  it("a frame split across two TCP chunks still lands", () => {
    // The framing buffer is part of the path, so it is part of the test.
    const status = latest(emitsFor(new ShureAxient(), "< REP 4 TX_BATT_M", "INS 00042 >"), "4");
    assert.equal(status.batteryMinutes, 42);
  });

  it("a driver that has never heard of runtime still reports null, not 0", () => {
    const status = latest(emitsFor(new ShureAxient(), "< REP 1 TX_BATT_CHARGE_PERCENT 077 >"), "1");
    assert.equal(status.batteryMinutes, null);
  });
});

describe("batteryMinutesFrom", () => {
  it("reads Shure's zero-padded minutes", () => {
    assert.equal(batteryMinutesFrom("00215"), 215);
    assert.equal(batteryMinutesFrom("0"), 0);
  });

  it("rejects all three sentinels", () => {
    // 65535 unknown, 65534 calculating, 65533 error. All three are "no answer".
    for (const v of ["65533", "65534", "65535"]) {
      assert.equal(batteryMinutesFrom(v), null, `${v} is a sentinel, not a duration`);
    }
  });

  it("rejects nonsense rather than passing NaN on", () => {
    assert.equal(batteryMinutesFrom("UNKNOWN"), null);
    assert.equal(batteryMinutesFrom(undefined), null);
    assert.equal(batteryMinutesFrom("-5"), null);
  });
});
