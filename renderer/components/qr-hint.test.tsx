// qr-hint.test.tsx — the colours of the code a person scans or prints.
//
// jsdom has no canvas, so the QR library's own drawing is replaced by one that keeps the
// pixels it was asked to write. What this holds is the choice of colour, which is the part a
// phone's scanner depends on: dark modules on an opaque white tile for `solid`, whatever the
// theme. How the tile looks beside the rest of the card is not unit-tested; it was driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { QrHint } = await import("./qr-hint.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** Every pixel the QR library draws, as r,g,b,a, so the colours can be read. */
let drawn: Uint8ClampedArray[] = [];
const proto = (window as unknown as { HTMLCanvasElement: { prototype: { getContext: unknown } } }).HTMLCanvasElement.prototype;
const real = proto.getContext;
beforeEach(() => {
  drawn = [];
  proto.getContext = () => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: (img: { data: Uint8ClampedArray }) => void drawn.push(img.data),
    clearRect() {},
    fillRect() {},
  });
});
afterEach(() => {
  proto.getContext = real;
});

function colours(data: Uint8ClampedArray): Set<string> {
  const px = new Set<string>();
  for (let i = 0; i < data.length; i += 4) px.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
  return px;
}

describe("QrHint", () => {
  test("solid is dark on an opaque white tile, in a dark theme too, so it scans and prints", async () => {
    document.documentElement.classList.add("dark");
    try {
      render(React.createElement(QrHint, { url: "https://example.test/servicecue", solid: true }));
      await eventually(() => assert.ok(drawn.length > 0, "no QR was drawn"));
      const px = colours(drawn.at(-1)!);
      assert.ok(px.has("255,255,255,255"), "no white tile");
      assert.ok(px.has("17,17,17,255"), "no dark modules");
      assert.equal([...px].some((p) => p.endsWith(",0")), false, "a transparent pixel: the code would take the page's colour");
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  test("the default stays transparent, tinted to the theme, for the places that sit on a themed surface", async () => {
    render(React.createElement(QrHint, { url: "https://example.test/x" }));
    await eventually(() => assert.ok(drawn.length > 0, "no QR was drawn"));
    const px = colours(drawn.at(-1)!);
    assert.equal(px.has("255,255,255,255"), false, "the themed code was given a white tile");
    assert.ok([...px].some((p) => p.endsWith(",0")), "the themed code has no transparent pixels");
  });
});
