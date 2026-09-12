// Every `GET 0 ALL` dump carries nineteen fields and the driver read six.
//
// The frames below are VERBATIM from an SBC220 on the LAN (FW 1.4.53, four units
// linked behind one IP reporting bays 1-8). Bay 7 has a failed pack in it: it
// still answers BATT_DETECTED YES, so it rendered as an ordinary occupied bay
// with dashes where its figures should be, and nothing anywhere said why.
//
// Driven from the bytes rather than by calling handleReport() with hand-made
// arguments, for the reason the runtime test gives: a device-level field is
// `REP {FIELD} {value}` with no channel token, and the driver used to return
// early on it. A test that called the handler directly would pass on a driver
// that never reaches the case.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceStatus } from "../../types/devices.js";
import { ShureCharger } from "./shure-charger.js";

function driven(...frames: string[]): { emits: DeviceStatus[]; provider: ShureCharger } {
  const provider = new ShureCharger();
  const emits: DeviceStatus[] = [];
  provider.onStatus((s) => emits.push(s));
  const inner = provider as unknown as {
    initChannelStates(count: number): void;
    handleData(chunk: string): void;
    cfg: { host: string; port: number; channels: number; meterRateMs: number };
  };
  inner.cfg = { host: "", port: 2202, channels: 8, meterRateMs: 1000 };
  inner.initChannelStates(8);
  for (const f of frames) inner.handleData(f);
  return { emits, provider };
}

function latest(emits: DeviceStatus[], channelId: string): DeviceStatus {
  const forChannel = emits.filter((s) => s.channelId === channelId);
  assert.ok(forChannel.length > 0, `nothing emitted for bay ${channelId}`);
  return forChannel[forChannel.length - 1]!;
}

// The faulted bay's slice of the real dump, in the order the charger sends it —
// which matters: BATT_STATE arrives before BATT_ERROR.
const FAULTED_BAY_7 = [
  "< REP 7 BATT_DETECTED YES >",
  "< REP 7 BATT_TIME_TO_FULL 65534 >",
  "< REP 7 BATT_STATE ERROR >",
  "< REP 7 BATT_CHARGE 254 >",
  "< REP 7 BATT_CYCLE 65534 >",
  "< REP 7 BATT_TEMP_F 254 >",
  "< REP 7 BATT_HEALTH 254 >",
  "< REP 7 BATT_ERROR 007 >",
];

describe("a faulted bay says so", () => {
  const { emits } = driven(...FAULTED_BAY_7);
  const bay = latest(emits, "7");

  it("carries the charger's own error code", () => {
    assert.equal(
      bay.fault,
      "Error 007",
      "BATT_ERROR was in every dump and read by nothing — the only signal a bay or " +
        "its battery is bad",
    );
  });

  it("still reads as occupied, because the battery is physically in it", () => {
    // Reporting it empty would hide the fault behind the same grey "empty" a
    // spare shelf shows.
    assert.equal(bay.online, true);
  });

  it("and BATT_ERROR arriving AFTER BATT_STATE does not undo the fault", () => {
    // The two arrive in separate frames. Writing `fault` from whichever landed
    // last would have a healthy-looking 000 wipe an ERROR state, or an ERROR
    // state overwrite a specific code with a generic word.
    const stateOnly = latest(driven(...FAULTED_BAY_7.slice(0, 3)).emits, "7");
    assert.equal(stateOnly.fault, "Error");
  });

  it("a code on a bay whose state reads FULL is still a fault", () => {
    const bay1 = latest(
      driven("< REP 1 BATT_DETECTED YES >", "< REP 1 BATT_STATE FULL >", "< REP 1 BATT_ERROR 003 >").emits,
      "1",
    );
    assert.equal(bay1.fault, "Error 003");
  });

  it("a healthy bay carries no fault at all", () => {
    const healthy = latest(
      driven("< REP 1 BATT_DETECTED YES >", "< REP 1 BATT_STATE FULL >", "< REP 1 BATT_ERROR 000 >").emits,
      "1",
    );
    assert.equal(healthy.fault, null);
  });

  it("and taking the battery out clears it rather than stranding it", () => {
    const pulled = latest(driven(...FAULTED_BAY_7, "< REP 7 BATT_DETECTED NO >").emits, "7");
    assert.equal(pulled.fault, null);
    assert.equal(pulled.online, false);
  });
});

describe("time to full", () => {
  it("reads the minutes a charging bay reports", () => {
    const bay = latest(driven("< REP 2 BATT_TIME_TO_FULL 00042 >").emits, "2");
    assert.equal(
      bay.timeToFullMinutes,
      42,
      "BATT_TIME_TO_FULL was in every dump and read by nothing — 'will this pack be " +
        "ready before the service' is exactly this field",
    );
  });

  it("a full bay answers not-applicable, which is not zero minutes", () => {
    // 65529 verbatim off the unit. Zero would render as "ready now" on a bay
    // that is not charging at all.
    const bay = latest(driven("< REP 1 BATT_TIME_TO_FULL 65529 >").emits, "1");
    assert.equal(bay.timeToFullMinutes, null);
  });

  it("and a faulted bay answers a marker too", () => {
    assert.equal(latest(driven(...FAULTED_BAY_7).emits, "7").timeToFullMinutes, null);
  });
});

describe("device-level fields, which used to return early and be logged away", () => {
  it("storage mode reaches every bay", () => {
    // A charger in storage mode charges to about 40% and stops. Without this an
    // operator sees 40% and no charging indicator and nothing to explain it.
    const { emits } = driven("< REP STORAGE_MODE ON >");
    for (const bay of ["1", "4", "8"]) {
      assert.equal(latest(emits, bay).storageMode, true, `bay ${bay} never heard about storage mode`);
    }
  });

  it("and OFF is false, not unknown", () => {
    assert.equal(latest(driven("< REP STORAGE_MODE OFF >").emits, "1").storageMode, false);
  });

  it("DEVICE_ID names the bays after the unit the operator named", async () => {
    // Verbatim, braces and trailing padding included: the device pads the name
    // to 31 characters, so the parse has to survive the spaces inside the braces.
    const { emits, provider } = driven("< REP DEVICE_ID {MA: 5-8                        } >");
    assert.equal(latest(emits, "3").name, "MA: 5-8 · Bay 3");
    const channels = await provider.listChannels();
    assert.equal(
      channels[2]?.label,
      "MA: 5-8 · Bay 3",
      "the picker still labels bays Ch 1..8 while the device has a better name",
    );
  });

  it("a bay discovered after the device id still gets the name", async () => {
    // `GET 0 ALL` dumps every populated bay, so bays self-discover past the
    // configured count — and the device-level frames arrive first.
    const { provider } = driven("< REP DEVICE_ID {MA: 5-8} >", "< REP 9 BATT_DETECTED YES >");
    const inner = provider as unknown as { channelStates: Map<number, { name: string | null }> };
    assert.equal(inner.channelStates.get(9)?.name, "MA: 5-8 · Bay 9");
  });

  it("with no DEVICE_ID the bays stay unnamed rather than inventing one", async () => {
    const channels = await driven().provider.listChannels();
    assert.equal(channels[0]?.label, "Ch 1");
  });
});
