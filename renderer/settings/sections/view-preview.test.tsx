// The iframe is the only thing between a preview and the real kiosk page it
// shows, and `pointer-events: none` is the one line that keeps every click and
// hover on the card embedding it (outputs-section.tsx's "Edit what X shows"
// overlay) rather than on the frame. Delete it and the button still renders —
// it just silently stops receiving the click, which pointer-events currently
// routes past the iframe to whatever sits behind it in the DOM.
//
// This is the sibling guard to kiosk-preview-boot.test.ts
// (../../kiosk-preview-boot.test.ts): that one proves a preview does not keep
// a wheel gesture; this one proves it does not keep a click either.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installRenderDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ViewPreview } = await import("./view-preview.js");

after(() => unmountAndTeardown(cleanup, teardown));

// NOT unit-tested here: that the preview's four corners are rounded (or, with
// `bleed`, square). The scaled
// iframe sits on its own compositor layer and the box clips it with a clip-path;
// jsdom loads no stylesheet and paints nothing, so a test could only read the style
// string back, which would pass whether or not any corner is clipped. It is checked
// in a browser, on the Screens tab, with a live preview showing a light top bar.

describe("ViewPreview's iframe", () => {
  test("never takes pointer or wheel input, so clicks and hover land on the card embedding it", () => {
    const { container } = render(React.createElement(ViewPreview, { viewId: "v1" }));
    const iframe = container.querySelector("iframe");
    assert.ok(iframe, "no iframe rendered");
    assert.equal(iframe!.style.pointerEvents, "none");
  });

  test("is a rounded, bordered box unless it is told to bleed", () => {
    // The View editor's preview is a ViewPreview with no `bleed`, and must keep its
    // own box; only the Screens cards ask for edge to edge.
    const plain = render(React.createElement(ViewPreview, { viewId: "v1" })).container.querySelector("iframe")!.parentElement!;
    assert.ok(plain.classList.contains("rounded-xl"), "the default preview lost its radius");
    assert.ok(!plain.classList.contains("border-x-0"), "the default preview lost its side borders");
    cleanup();
    const bleed = render(React.createElement(ViewPreview, { viewId: "v1", bleed: true })).container.querySelector("iframe")!.parentElement!;
    assert.ok(!bleed.classList.contains("rounded-xl"), "a bleed preview kept its radius");
    assert.ok(bleed.classList.contains("border-x-0"), "a bleed preview kept its side borders");
  });
});
