// A bindable channel says what it IS, so a picker can offer the right ones.
//
// The Mic channel widget's picker listed every bindable channel, which on a rig
// with three SBC chargers meant twenty-four battery bays against twelve mics.
// Pick a bay and the widget draws a dash for ever: a bay has no RF and no
// frequency, and `charger-battery` is the widget for it.
//
// The tempting shortcut is to derive this from the live telemetry, which already
// carries deviceType. It does not work: telemetry exists only for gear that has
// reported, and binding a widget to a receiver that is still in its case is
// exactly when somebody opens a picker. So the CHANNEL LIST carries it, and this
// drives each provider's real listChannels() to prove it arrives.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ShureAxient } from "./shure-axient.js";
import { ShureCharger } from "./shure-charger.js";
import { ShurePsm } from "./shure-psm.js";
import { ShureUlxd } from "./shure-ulxd.js";

type Listable = { listChannels(): Promise<{ id: string; label: string; deviceType: string }[]> };

/**
 * Spin a provider up to `count` channels without a socket, and list them.
 *
 * Both halves are needed: `initChannelStates` builds the state map, and `cfg`
 * is what `listChannels` actually loops over. Setting only the first returned
 * one channel per provider — the config default — and the fixture counts below
 * caught that, which is why they are exact.
 */
async function channelsOf(provider: unknown, count: number) {
  const inner = provider as {
    initChannelStates(n: number): void;
    cfg: { host: string; port: number; channels: number; meterRateMs: number };
  };
  inner.cfg = { host: "", port: 2202, channels: count, meterRateMs: 1000 };
  inner.initChannelStates(count);
  return (provider as Listable).listChannels();
}

describe("every provider labels its channels", () => {
  test("a mic receiver reports receivers", async () => {
    const channels = await channelsOf(new ShureAxient(), 4);
    assert.equal(channels.length, 4);
    for (const c of channels) assert.equal(c.deviceType, "receiver", `${c.label} is not a receiver`);
  });

  test("ULX-D too", async () => {
    const channels = await channelsOf(new ShureUlxd(), 2);
    for (const c of channels) assert.equal(c.deviceType, "receiver");
  });

  test("a PSM transmitter reports IEM, which the picker still offers", async () => {
    // IEM packs belong in the Mic channel widget — they have RF and a battery.
    // Only chargers are excluded, so this must NOT read as "charger".
    const channels = await channelsOf(new ShurePsm(), 2);
    for (const c of channels) assert.equal(c.deviceType, "iem");
  });

  test("a charger reports charger", async () => {
    const channels = await channelsOf(new ShureCharger(), 8);
    assert.equal(channels.length, 8);
    for (const c of channels) assert.equal(c.deviceType, "charger", `bay ${c.label} is not marked a charger`);
  });
});

describe("what a Mic channel picker is left with", () => {
  test("mics and IEMs, and no charger bays", async () => {
    // The rig this was found on: three 4-channel receivers and three 8-bay
    // chargers. Twelve bindable channels, twenty-four bays.
    const rf = [
      ...(await channelsOf(new ShureAxient(), 4)),
      ...(await channelsOf(new ShureAxient(), 4)),
      ...(await channelsOf(new ShureAxient(), 4)),
    ];
    const bays = [
      ...(await channelsOf(new ShureCharger(), 8)),
      ...(await channelsOf(new ShureCharger(), 8)),
      ...(await channelsOf(new ShureCharger(), 8)),
    ];
    const all = [...rf, ...bays];
    assert.equal(all.length, 36, "fixture no longer matches the rig it was drawn from");

    const offered = all.filter((c) => c.deviceType !== "charger");
    assert.equal(offered.length, 12, "the picker is offering something that is not a mic");
    assert.equal(all.length - offered.length, 24, "the bays are not all excluded");
  });
});
