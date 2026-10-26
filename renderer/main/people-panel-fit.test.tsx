// The people panel's block may be taller than its box, and is scaled about its
// centre, so it has to be laid out at its own height.
//
// A fixed `height: 100%` let rows that wrapped past the box overflow BELOW it; the
// block was then scaled about the centre of the 100%-tall layout box, not the centre
// of what it held, and its bottom (39px of a 300px box with three metrics) ran off
// the box and was clipped. Browser-measured before and after (see the commit); jsdom
// lays nothing out, so this pins the layout that makes the centring true: the block
// is at least the box (so a short one still fills it) and never a fixed height.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom } from "../test-dom.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom({ clientHeight: 240 });
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

test("the scaled block is at least its box and has no fixed height", () => {
  const o = {
    id: "p", x: 0, y: 0, w: 0.3, h: 0.28, z: 1,
    config: { type: "people-panel", metrics: ["occupancy", "peak", "attendance"] },
    style: { fontSize: 0.12, fontWeight: 700, color: "#ffffff" },
  } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o, ctx: makeRenderCtx() }));
  const block = [...container.querySelectorAll("div")].find((d) => /scale\(/.test(d.style.transform)) as HTMLElement | undefined;
  assert.ok(block, "no scaled block was drawn");
  assert.equal(block.style.minHeight, "100%");
  assert.equal(block.style.height, "", "a fixed height lets wrapped rows overflow the box the scale is centred on");
  assert.equal(block.style.transformOrigin, "center center");
});
