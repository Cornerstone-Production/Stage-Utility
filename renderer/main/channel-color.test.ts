// resolveChannelColor() is the one function every caption color in the app goes
// through: the full transcription view, the dashboard/stage strips, the
// transcript-strip layout object, and the Transcription colors panel's own
// swatches. This tests the resolution rule directly, which is what all of
// those call — a render-level test of each of them would only be re-proving
// this same logic through more machinery.
//
// The rule ProdCom 2.3.2 makes necessary: it DOES send a color per channel, and
// it repeats them (five channels share one hex on the real box, six share
// another) — so ProdCom's color is used only when the operator has opted in
// (followProdcom), never as an unconditional default the way an earlier
// version of this file assumed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { channelColor, lineColor, resolveChannelColor } from "./channel-color.js";

describe("resolveChannelColor — the one shared decision", () => {
  it("a custom pick wins with following OFF", () => {
    const color = resolveChannelColor({
      channel: "CH-A",
      label: "Lead TB",
      prodcomColor: "#FF2600",
      followProdcom: false,
      customColors: { "Lead TB": "#123456" },
    });
    assert.equal(color, "#123456");
  });

  it("a custom pick wins with following ON too — it always wins", () => {
    const color = resolveChannelColor({
      channel: "CH-A",
      label: "Lead TB",
      prodcomColor: "#FF2600",
      followProdcom: true,
      customColors: { "Lead TB": "#123456" },
    });
    assert.equal(color, "#123456");
  });

  it("with no custom pick and following OFF, ProdCom's color is ignored — the distinct auto color is the default", () => {
    const color = resolveChannelColor({
      channel: "CH-A",
      label: "Lead TB",
      prodcomColor: "#FF2600",
      followProdcom: false,
      customColors: {},
    });
    assert.equal(
      color,
      channelColor("CH-A"),
      "ProdCom's color leaked through as the default when following is off",
    );
    assert.notEqual(color, "#FF2600", "the distinct auto color happened to collide with the fixture — pick another");
  });

  it("with no custom pick and following ON, ProdCom's color is used", () => {
    const color = resolveChannelColor({
      channel: "CH-A",
      label: "Lead TB",
      prodcomColor: "#FF2600",
      followProdcom: true,
      customColors: {},
    });
    assert.equal(color, "#FF2600");
  });

  it("following ON but ProdCom sent no color for this channel falls back to the auto color", () => {
    const color = resolveChannelColor({
      channel: "CH-Z",
      label: "No Colour Set",
      prodcomColor: null,
      followProdcom: true,
      customColors: {},
    });
    assert.equal(color, channelColor("CH-Z"));
  });

  it("reset (clearing the custom pick) returns to whichever default is active", () => {
    const base = { channel: "CH-A", label: "Lead TB", prodcomColor: "#FF2600", customColors: {} };
    // Follow off → the auto default.
    assert.equal(resolveChannelColor({ ...base, followProdcom: false }), channelColor("CH-A"));
    // Follow on → ProdCom's default.
    assert.equal(resolveChannelColor({ ...base, followProdcom: true }), "#FF2600");
  });

  it("a channel with no id at all (an orphaned saved pick) still resolves to SOME auto color", () => {
    const color = resolveChannelColor({
      channel: null,
      label: "Gone Channel",
      prodcomColor: null,
      followProdcom: true,
      customColors: {},
    });
    assert.equal(color, channelColor(null));
  });
});

describe("lineColor — resolveChannelColor applied to a transcript line", () => {
  const line = { channel: "CH-A", channelName: "Lead TB", color: "#FF2600" };

  it("defaults to NOT following ProdCom's color when the caller passes nothing", () => {
    assert.equal(lineColor(line, {}), channelColor("CH-A"));
  });

  it("follows ProdCom's color when told to", () => {
    assert.equal(lineColor(line, {}, true), "#FF2600");
  });

  it("a custom override still wins over ProdCom's color", () => {
    assert.equal(lineColor(line, { "Lead TB": "#123456" }, true), "#123456");
  });
});
