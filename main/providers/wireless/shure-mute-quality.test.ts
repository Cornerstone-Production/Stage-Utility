// A muted pack reports five bars and a full battery.
//
// That is the whole problem: on a stage display it looks perfect while nothing
// comes out of it, and for a church it is the most common live failure there is.
// The receivers were sending the answer the whole time and BOTH drivers dropped
// it — and each had invented a token name its own gear does not send. The Axient
// driver handled `MUTE_MODE_STATUS`; an AD4 sends `TX_MUTE_MODE_STATUS`. The
// ULX-D driver handled `MUTE_STATUS`; a ULX-D sends `AUDIO_MUTE` and
// `TX_MUTE_STATUS`. Both logged the value and stored nothing anyway, so even the
// right spelling would have changed nothing.
//
// Every token and value below is from Shure's own command-string references
// (AD4, and the ULX-D applications bulletin), because the receivers were not
// reachable from this machine and a guessed polarity is worse than no feature:
// get it backwards and every unmuted pack on the wall reads MUTED.
//
// Driven from raw bytes, so the assertion covers the parse path a `MUTE_STATUS`
// case would have satisfied while the device sent something else.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceStatus } from "../../types/devices.js";
import { ShureAxient } from "./shure-axient.js";
import { ShureUlxd } from "./shure-ulxd.js";
import { muteModeMute, onOffMute } from "./shure-base.js";

function emits(provider: object, ...frames: string[]): DeviceStatus[] {
  const seen: DeviceStatus[] = [];
  const inner = provider as {
    onStatus(cb: (s: DeviceStatus) => void): void;
    initChannelStates(count: number): void;
    handleData(chunk: string): void;
  };
  inner.onStatus((s) => seen.push(s));
  inner.initChannelStates(4);
  for (const f of frames) inner.handleData(f);
  return seen;
}

function latest(list: DeviceStatus[], channelId: string): DeviceStatus {
  const forChannel = list.filter((s) => s.channelId === channelId);
  assert.ok(forChannel.length > 0, `nothing emitted for channel ${channelId}`);
  return forChannel[forChannel.length - 1]!;
}

describe("mute reaches the emitted status", () => {
  it("an AD4 pack muted at the transmitter", () => {
    // TX_MUTE_MODE_STATUS: ON = audio OPEN, MUTE = muted. The token the driver
    // used to watch for was MUTE_MODE_STATUS, which no AD4 sends.
    const s = latest(emits(new ShureAxient(), "< REP 1 TX_MUTE_MODE_STATUS MUTE >"), "1");
    assert.equal(s.muted, true, "a muted pack reached the display as a healthy one");
  });

  it("and the same pack unmuted", () => {
    assert.equal(latest(emits(new ShureAxient(), "< REP 1 TX_MUTE_MODE_STATUS ON >"), "1").muted, false);
  });

  it("a ULX-D channel muted at the receiver", () => {
    assert.equal(latest(emits(new ShureUlxd(), "< REP 2 AUDIO_MUTE ON >"), "2").muted, true);
  });

  it("a ULXD6 handheld muted at the pack", () => {
    assert.equal(latest(emits(new ShureUlxd(), "< REP 2 TX_MUTE_STATUS ON >"), "2").muted, true);
  });

  it("either side muting counts, and one un-muting does not clear the other", () => {
    // The two arrive on their own cadences. Written into one field by whichever
    // landed last, a pack muted at the transmitter un-mutes itself the next time
    // AUDIO_MUTE OFF comes round — with the pack still muted.
    const s = latest(
      emits(new ShureUlxd(), "< REP 1 TX_MUTE_STATUS ON >", "< REP 1 AUDIO_MUTE OFF >"),
      "1",
    );
    assert.equal(s.muted, true, "a receiver-side un-mute wiped a transmitter-side mute");
  });

  it("and clearing BOTH sides is unmuted", () => {
    const s = latest(
      emits(
        new ShureUlxd(),
        "< REP 1 TX_MUTE_STATUS ON >",
        "< REP 1 AUDIO_MUTE OFF >",
        "< REP 1 TX_MUTE_STATUS OFF >",
      ),
      "1",
    );
    assert.equal(s.muted, false);
  });

  it("no transmitter is unknown, not unmuted", () => {
    assert.equal(latest(emits(new ShureAxient(), "< REP 1 TX_MUTE_MODE_STATUS UNKNOWN >"), "1").muted, null);
    assert.equal(latest(emits(new ShureUlxd(), "< REP 1 TX_MUTE_STATUS UNKN >"), "1").muted, null);
  });

  it("the mute BUTTON is not the mute state", () => {
    // PRESSED/RELEASED on a ULXD6/8 is the physical button, which can be
    // momentary or latching. TX_MUTE_STATUS is the real state on the same models.
    assert.equal(
      latest(emits(new ShureUlxd(), "< REP 1 TX_MUTE_BUTTON_STATUS PRESSED >"), "1").muted,
      null,
    );
  });

  it("nor is a talk switch", () => {
    // OFF is a push-to-talk's RESTING state. Read as muted, every pack with one
    // reads muted for the whole service.
    assert.equal(latest(emits(new ShureAxient(), "< REP 1 TX_TALK_SWITCH OFF >"), "1").muted, null);
  });
});

describe("the two mute polarities, which are opposite on the same word", () => {
  it("AUDIO_MUTE / TX_MUTE_STATUS: ON is muted", () => {
    assert.equal(onOffMute("ON"), true);
    assert.equal(onOffMute("OFF"), false);
    assert.equal(onOffMute("UNKN"), null);
  });

  it("TX_MUTE_MODE_STATUS: ON is OPEN and MUTE is muted", () => {
    assert.equal(muteModeMute("ON"), false);
    assert.equal(muteModeMute("MUTE"), true);
    assert.equal(muteModeMute("UNKNOWN"), null);
  });
});

describe("channel quality and interference", () => {
  it("quality arrives inside SAMPLE, which is the only place it arrives", () => {
    // CHAN_QUALITY is a metered property: the device sends no REP when it
    // changes. The frame is the shape Shure's AD4 reference documents, and
    // token 3 is the quality this driver's own comment named and never read.
    const s = latest(
      emits(new ShureAxient(), "< SAMPLE 1 ALL 004 031 102 102 BB 31 086 31 065 >"),
      "1",
    );
    assert.equal(s.quality, 4, "channel quality was named in the comment and read by nothing");
  });

  it("quality survives the SLOT-level frame's two-token shift", () => {
    const s = latest(
      emits(new ShureAxient(), "< SAMPLE 2 SLOT 1 ALL 002 031 102 102 BB 31 086 31 065 >"),
      "2",
    );
    assert.equal(s.quality, 2);
  });

  it("255 in SAMPLE is unknown, not a quality of 255", () => {
    const s = latest(
      emits(new ShureAxient(), "< SAMPLE 1 ALL 255 031 102 102 BB 31 086 31 065 >"),
      "1",
    );
    assert.equal(s.quality, null);
  });

  it("a REP CHAN_QUALITY is read too", () => {
    assert.equal(latest(emits(new ShureAxient(), "< REP 1 CHAN_QUALITY 005 >"), "1").quality, 5);
  });

  it("Axient interference", () => {
    assert.equal(
      latest(emits(new ShureAxient(), "< REP 1 INTERFERENCE_STATUS DETECTED >"), "1").interference,
      true,
      "eight Companion buttons watch this and the app dropped it into a console.log",
    );
    assert.equal(
      latest(emits(new ShureAxient(), "< REP 1 INTERFERENCE_STATUS NONE >"), "1").interference,
      false,
    );
  });

  it("ULX-D interference, which that driver handled nowhere at all", () => {
    // RF_INT_DET is the ULX-D spelling and its detected value is CRITICAL.
    assert.equal(latest(emits(new ShureUlxd(), "< REP 1 RF_INT_DET CRITICAL >"), "1").interference, true);
    assert.equal(latest(emits(new ShureUlxd(), "< REP 1 RF_INT_DET NONE >"), "1").interference, false);
  });

  it("and an FD-C channel's second frequency counts as the same channel", () => {
    assert.equal(
      latest(emits(new ShureAxient(), "< REP 1 INTERFERENCE_STATUS2 DETECTED >"), "1").interference,
      true,
    );
  });
});
