import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { cardFrame } from "./home-grid.js";
import { defaultStyle } from "../../main/layout-objects.js";
import type { LayoutObject } from "@main/types/views";

// Every tile on Home has ONE edge.
//
// Reported as "some widgets do not seem to have the same border px or shine —
// the edges seem inconsistent", and measured in a browser: Home's own cards drew
// a 12px radius with a 0.09 hairline, while a stage widget in the tile beside
// them drew 10.656px and 0.08. Not a rounding artefact — a widget's radius and
// border width are FRACTIONS OF CANVAS HEIGHT (0.0148 x 720 = 10.656), which is
// right on a display and meaningless in a dashboard grid.
//
// So Home supplies the frame and the object supplies the colour.

const obj = (type: string): LayoutObject =>
  ({ id: type, x: 0, y: 0, w: 0.2, h: 0.2, z: 0, config: { type }, style: defaultStyle(type as never) }) as never;

describe("the frame Home draws", () => {
  test("radius and border are NOT taken from the object", () => {
    // The two fields that were measurably different. They come from the app's
    // card tokens on the wrapper instead, so every tile agrees.
    const frame = cardFrame(obj("clock"), 720);
    assert.equal(frame.borderRadius, undefined, "a canvas-fraction radius is back");
    assert.equal(frame.border, undefined, "a canvas-fraction border is back");
  });

  test("every widget type yields the same absence", () => {
    // An exact sweep rather than one example: a type whose style set the radius
    // by some other route would be the one tile with a different corner.
    const withGeometry = ["clock", "obs-status", "people-panel", "notes", "spl-meter", "wireless-channel"]
      .map((t) => ({ t, f: cardFrame(obj(t), 720) }))
      .filter(({ f }) => f.borderRadius !== undefined || f.border !== undefined)
      .map(({ t }) => t);
    assert.deepEqual(withGeometry, []);
  });

  test("the object's dark GROUND is dropped too", () => {
    // THE light-mode guard, and the one this file originally got backwards: it
    // asserted the object's background came through, which is true on a black
    // wall and catastrophic on an app page that can be light.
    //
    // A widget's ground is written for a display — #141414. Home's own cards use
    // the app's translucent surface token. Put those on a light page together
    // and the widget is a black slab while Home's cards go fully transparent
    // with white text on them: measured at about 1.07:1 on a phone. Invisible.
    //
    // Home supplies `bg-surface` for every tile instead, so the grid follows the
    // theme.
    const ground = defaultStyle("clock" as never).background;
    assert.ok(ground, "the fixture stopped carrying a ground, so this proves nothing");
    assert.equal(cardFrame(obj("clock"), 720).background, undefined, "a display ground reached Home");
  });

  test("no widget type leaks a ground onto Home", () => {
    const leaking = ["clock", "obs-status", "people-panel", "notes", "spl-meter", "section-chip"]
      .filter((t) => cardFrame(obj(t), 720).background !== undefined);
    assert.deepEqual(leaking, []);
  });

  test("what Home does NOT take from the object is still the object's", () => {
    // The frame and the ground are Home's; ALIGNMENT is the operator's, and
    // stripping that would flatten every widget into the same tile whatever they
    // set. Padding and opacity used to be here too — they are gone from the
    // model entirely now, so there is nothing to pass through.
    const frame = cardFrame(obj("clock"), 720);
    assert.ok(frame.justifyContent !== undefined, "vertical alignment stopped coming from the object");
    assert.equal(frame.padding, undefined, "padding is back, and the readout supplies its own");
  });
});
