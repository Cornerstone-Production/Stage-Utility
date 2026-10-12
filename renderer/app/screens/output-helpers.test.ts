import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cardOf, outputModeLine, outputStruggleSentences, refreshRate, struggleByScreen } from "./output-helpers.js";
import type { OutputHealth } from "@main/types/output-health";

describe("the card in an output's name", () => {
  it("is what follows the port", () => {
    assert.equal(cardOf({ kind: "decklink", name: "SDI 1 · DeckLink Duo 2", port: "SDI 1" }), "DeckLink Duo 2");
  });

  it("is the whole name when it does not start with the port", () => {
    assert.equal(cardOf({ kind: "decklink", name: "Duo 2, first port", port: "SDI 1" }), "Duo 2, first port");
  });

  it("keeps a separator inside the card's own name", () => {
    assert.equal(cardOf({ kind: "decklink", name: "SDI 2 · Card · rev B", port: "SDI 2" }), "Card · rev B");
  });
});

describe("a refresh rate out of a mode", () => {
  it("is read after an @, or before Hz", () => {
    assert.equal(refreshRate("1920x1080@60"), "60 Hz");
    assert.equal(refreshRate("3840x2160@29.97"), "29.97 Hz");
    assert.equal(refreshRate("1920x1080 59.94Hz"), "59.94 Hz");
  });

  it("is absent when the mode names none, as a Linux agent's never does", () => {
    assert.equal(refreshRate("1920x1080"), undefined);
    assert.equal(refreshRate(undefined), undefined);
  });
});

describe("the mode line of an output", () => {
  const SDI = { kind: "decklink" as const };
  const HDMI = { kind: "display" as const };

  it("is the mode the screen is set to for a DeckLink port, the house mode until then", () => {
    assert.equal(outputModeLine(SDI, "1080p50", undefined), "1080p50");
    assert.equal(outputModeLine(SDI, undefined, undefined), "1080p59.94");
  });

  it("ignores a DeckLink port's screen size, and a display's video mode", () => {
    assert.equal(outputModeLine(SDI, undefined, { w: 1280, h: 720 }), "1080p59.94");
    assert.equal(outputModeLine(HDMI, "1080p50", { w: 1920, h: 1080 }), "1920 × 1080");
  });

  it("is the size a display is driven at, and the rate when the probe carries one", () => {
    assert.equal(outputModeLine(HDMI, undefined, { w: 0, h: 0, mode: "1920x1080@60" }), "1920 × 1080 · 60 Hz");
    assert.equal(outputModeLine(HDMI, undefined, { w: 0, h: 0, mode: "1920x1080" }), "1920 × 1080");
  });

  it("prefers the driven mode to the browser's size, and falls back to it", () => {
    assert.equal(outputModeLine(HDMI, undefined, { w: 1280, h: 720, mode: "1920x1080@60" }), "1920 × 1080 · 60 Hz");
    assert.equal(outputModeLine(HDMI, undefined, { w: 1280, h: 720 }), "1280 × 720");
  });

  it("is empty for a display nothing is known about", () => {
    assert.equal(outputModeLine(HDMI, undefined, undefined), "");
    assert.equal(outputModeLine(HDMI, undefined, { w: 0, h: 0 }), "");
  });
});

describe("what a struggling output's card says", () => {
  it("names the late page when frames repeated, then what to check", () => {
    assert.deepEqual(outputStruggleSentences({ repeated: 12.4, dropped: 0 }), [
      "12% of its frames repeated because the page ran late.",
      "Check the Mac's load and how much this screen's view draws.",
    ]);
  });

  it("names the card's dropped frames when it dropped some", () => {
    assert.deepEqual(outputStruggleSentences({ repeated: 0.2, dropped: 41 }), [
      "The card has dropped 41 frames since the output opened.",
      "Check the Mac's load and how much this screen's view draws.",
    ]);
  });

  it("names both when both are true", () => {
    assert.equal(outputStruggleSentences({ repeated: 9, dropped: 3 }).length, 3);
  });
});

describe("which screens have a struggling output", () => {
  const report = (deviceId: string, struggling: boolean): OutputHealth =>
    ({ deviceId, fps: 59.94, repeated: 12, dropped: 4, at: 1, receivedAt: 2, struggling });
  const sdi = (id: string, outputId: string) => ({ id, outputId, output: { kind: "decklink" as const, name: `${id} name`, port: id.toUpperCase() } });

  it("is the screen of each bound output whose report says so, by screen id", () => {
    const got = struggleByScreen(
      [sdi("sdi-1", "display-1"), sdi("sdi-2", "display-2"), { id: "pi", outputId: "display-3" }],
      [report("sdi-1", true), report("sdi-2", false), report("pi", true)],
    );
    assert.deepEqual([...got], [["display-1", { port: "SDI-1", repeated: 12, dropped: 4 }]]);
  });

  it("is nothing for an output that has not reported", () => {
    assert.deepEqual([...struggleByScreen([sdi("sdi-1", "display-1")], [])], []);
  });
});
