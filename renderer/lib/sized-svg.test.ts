// The size an SVG is given before the crop editor draws it.
//
// jsdom has DOMParser and XMLSerializer, so the sizing runs for real here. What it
// cannot show is Chrome's handling of the result on a canvas, which is where the bug
// was: that is checked by cropping a viewBox-only SVG in the browser (see the PR).

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
// installDom() does not expose these two; the module reads them as browser globals.
Object.assign(globalThis, { DOMParser: window.DOMParser, XMLSerializer: window.XMLSerializer });
const { isSvgSource, sizeSvgText, SVG_LONG_SIDE } = await import("./sized-svg.js");
after(() => {
  teardown();
  delete (globalThis as Record<string, unknown>).DOMParser;
  delete (globalThis as Record<string, unknown>).XMLSerializer;
});

const dims = (svg: string | null) => {
  const root = new DOMParser().parseFromString(svg ?? "", "image/svg+xml").documentElement;
  return [Number(root.getAttribute("width")), Number(root.getAttribute("height"))];
};

describe("sizeSvgText", () => {
  test("a viewBox-only square gets the long side in both directions", () => {
    const out = sizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="9" height="9"/></svg>');
    assert.ok(out !== null, "a viewBox-only SVG was left unsized");
    assert.deepEqual(dims(out), [SVG_LONG_SIDE, SVG_LONG_SIDE]);
    assert.match(out, /viewBox="0 0 200 200"/, "the viewBox is kept");
    assert.match(out, /<rect/, "the artwork is kept");
  });

  test("a wide viewBox keeps its aspect", () => {
    assert.deepEqual(dims(sizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"/>')), [1024, 256]);
  });

  test("an SVG with plain numeric width and height is left alone, so saved crops still fit it", () => {
    assert.equal(sizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" width="300px" height="100" viewBox="0 0 10 10"/>'), null);
    assert.equal(sizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"/>'), null);
  });

  test("only one of width and height is not enough", () => {
    assert.deepEqual(dims(sizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" width="200" viewBox="0 0 100 50"/>')!), [1024, 512]);
  });

  test("percent sizes are not sizes: the viewBox decides", () => {
    assert.deepEqual(dims(sizeSvgText('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 50 100"/>')), [512, 1024]);
  });

  test("no size and no viewBox is the browser's own 2:1 default", () => {
    assert.deepEqual(dims(sizeSvgText('<svg xmlns="http://www.w3.org/2000/svg"/>')), [1024, 512]);
  });

  test("something that is not an SVG document is refused", () => {
    assert.throws(() => sizeSvgText("<html><body/></html>"), /not a valid SVG/);
    assert.throws(() => sizeSvgText("<svg"), /not a valid SVG/);
  });
});

describe("isSvgSource", () => {
  test("by data URL or file extension, and nothing else", () => {
    assert.equal(isSvgSource("data:image/svg+xml;base64,AAAA"), true);
    assert.equal(isSvgSource("/branding-images/0123456789abcdef.svg"), true);
    assert.equal(isSvgSource("/branding-images/0123456789abcdef.png"), false);
    assert.equal(isSvgSource("data:image/png;base64,AAAA"), false);
  });
});
