// The editor draws in DESIGN pixels, whatever the layout's fit is.
//
// It used to draw a responsive layout into the live box instead — a status
// widget 29px tall in a half-size editor pane against 58px on the display. That
// is fine for anything sized as a fraction, which is most of a layout, and wrong
// for anything with a pixel FLOOR. The readout idiom has two: a caption never
// goes below 9px and a sub-line never below 10px. At 29px the caption floor took
// a third of the box and the value was squeezed to 7px, where the same widget on
// the display drew it at 19px. Measured both ways in a browser, and reported as
// the small widgets in a custom layout not looking like what they are.
//
// So this asserts the space, not the pixels: the content layer is the design
// canvas, scaled by a transform. A layer sized to the live box cannot satisfy it.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { EditorCanvas } = await import("./layout-editor.js");
const { fitComposition } = await import("../main/readout-size.js");

const CANVAS = { width: 1920, height: 1080, background: null };

// jsdom lays nothing out, and the canvas draws nothing at a zero-size wrapper —
// so the pane is given a size the way a browser would report one. Deliberately
// NOT the design canvas: the whole bug was a layer that followed the pane.
const PANE = { width: 1000, height: 600 };
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  return { ...PANE, top: 0, left: 0, right: PANE.width, bottom: PANE.height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
};

after(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
  teardown();
});

/** One readout, the shape that showed the bug. */
const OBJECTS = [
  {
    id: "o1",
    x: 0.03, y: 0.16, w: 0.18, h: 0.054, z: 1,
    config: { type: "obs-status", mode: "recording", showTimecode: false, hideWhenIdle: false, fillWhenRecording: true },
    style: {},
  },
];

function mount() {
  return render(
    React.createElement(EditorCanvas as never, {
      canvas: CANVAS,
      objects: OBJECTS,
      selectedId: null,
      selectedIds: new Set<string>(),
      gridOn: false,
      alignOn: false,
      locked: false,
      // Everything the objects read comes off the context, so a bare one renders.
      ctx: { now: Date.now(), skewMs: 0, H: 0, interactive: false },
      ndiSource: null,
      interactive: false,
      onSelect: () => {},
      onMarqueeSelect: () => {},
      onGeom: () => {},
      onGeomMany: () => {},
      onCommitStart: () => {},
      onReparent: () => {},
    } as never),
  );
}

/** The layer the objects live in: the one carrying a scale transform. */
function contentLayer(container: HTMLElement): HTMLElement | null {
  return [...container.querySelectorAll("div")].find((d) => /scale\(/.test(d.style.transform)) ?? null;
}

describe("the editor canvas' coordinate space", () => {
  test("the content layer is the design canvas, scaled", () => {
    // jsdom reports a zero-size wrapper, so the canvas box is not laid out. The
    // layer's declared size is what this is about, and that is set from the
    // canvas rather than from any measurement.
    const { container } = mount();
    const layer = contentLayer(container);
    assert.ok(layer, "no scaled content layer — the editor is drawing in live-box pixels again");
    assert.equal(layer.style.width, `${CANVAS.width}px`, "content width is not the design canvas");
    assert.equal(layer.style.height, `${CANVAS.height}px`, "content height is not the design canvas");
    assert.notEqual(layer.style.width, `${PANE.width}px`, "the layer followed the pane");
    cleanup();
  });

  test("and that matters, because the composition is not scale-invariant", () => {
    // The reason the space has to be the design canvas rather than "whatever is
    // proportionally the same". Halve the box and the value takes a different
    // share of it, because the caption's floor does not halve with it.
    const big = fitComposition(58, true, false);
    const small = fitComposition(29, true, false);
    assert.equal(big.captionPx, small.captionPx, "the caption floor is what makes these differ");
    const bigShare = big.valuePx / 58;
    const smallShare = small.valuePx / 29;
    assert.ok(
      bigShare - smallShare > 0.1,
      `a half-size box changes the value's share by ${(bigShare - smallShare).toFixed(3)} — ` +
        "if this is ever ~0 the floors are gone and the guard above is obsolete",
    );
  });
});
