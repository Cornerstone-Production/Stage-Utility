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

describe("ViewPreview's iframe", () => {
  test("never takes pointer or wheel input, so clicks and hover land on the card embedding it", () => {
    const { container } = render(React.createElement(ViewPreview, { viewId: "v1" }));
    const iframe = container.querySelector("iframe");
    assert.ok(iframe, "no iframe rendered");
    assert.equal(iframe!.style.pointerEvents, "none");
  });
});
