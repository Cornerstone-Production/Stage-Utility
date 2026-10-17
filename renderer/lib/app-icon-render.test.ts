// Where the art goes in each icon.
//
// jsdom has no canvas, so what is checked here is the layout over a recorded
// context: the background fills the whole square, and the maskable icon's art keeps
// to the centre 80% while the others fill the square. The pixels themselves, and
// that the PNGs come out at the sizes POST /api/branding demands, are checked by
// driving Chrome (see the PR), not by a test that would only read a stub.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { ART_FRACTION, drawIcon, layoutIcon, MASKABLE_ART, type IconContext } from "./app-icon-render";

function recorder() {
  const calls: string[] = [];
  const ctx: IconContext = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect: (x, y, w, h) => calls.push(`fill ${String(ctx.fillStyle)} ${x},${y} ${w}x${h}`),
    drawImage: (_i, x, y, w, h) => calls.push(`art ${x},${y} ${w}x${h}`),
  };
  return { ctx, calls };
}

describe("layoutIcon", () => {
  test("full size sits at the origin, and 80% is centred", () => {
    assert.deepEqual(layoutIcon(512, 1), { art: 512, offset: 0 });
    assert.deepEqual(layoutIcon(512, MASKABLE_ART), { art: 410, offset: 51 });
  });

  test("the margins on either side of the art are within a pixel of each other", () => {
    for (const size of [180, 192, 512]) {
      const { art, offset } = layoutIcon(size, MASKABLE_ART);
      assert.ok(Math.abs(size - art - offset * 2) <= 1, `${size}: ${offset} + ${art} + ${offset}`);
    }
  });
});

describe("which icon gets which share of its square", () => {
  // The constant above can be right and the table wrong: the maskable icon filling
  // its square (cropped by Android's round mask), or a plain icon shrunk.
  test("only the maskable icon keeps clear of the edge", () => {
    assert.deepEqual(ART_FRACTION, { apple: 1, any192: 1, any512: 1, maskable: MASKABLE_ART });
  });
});

describe("drawIcon", () => {
  test("fills the whole square with the background first, then the art over it", () => {
    const { ctx, calls } = recorder();
    drawIcon(ctx, {} as CanvasImageSource, 192, "#15425c", 1);
    assert.deepEqual(calls, ["fill #15425c 0,0 192x192", "art 0,0 192x192"]);
  });

  test("a maskable icon keeps its art inside the centre 80%", () => {
    const { ctx, calls } = recorder();
    drawIcon(ctx, {} as CanvasImageSource, 512, "#000000", MASKABLE_ART);
    assert.deepEqual(calls, ["fill #000000 0,0 512x512", "art 51,51 410x410"]);
    // The art ends 51 px short of every edge: 10% of the side, inside the safe zone.
    assert.ok(51 + 410 <= 512 * 0.9 + 1);
  });
});
