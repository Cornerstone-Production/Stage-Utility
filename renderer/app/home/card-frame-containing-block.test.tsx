// A filled widget paints inside Home's card, not over its border.
//
// The mechanism, and the browser measurements, are on `cardFrame` in
// home-grid.tsx. This is the part that can be checked without a browser: which
// element a widget's composition resolves against.
//
// ── What this can and cannot prove ─────────────────────────────────────────
// jsdom loads no stylesheet and does no layout, so nothing here may assert a
// rendered radius, a border width or a painted rectangle — a test that read
// `getComputedStyle().borderRadius` would come back "0px" for the fixed code
// and the broken code alike, and pass on the bug. Those were measured in a real
// browser instead and the numbers are quoted in home-grid.tsx.
//
// CONTAINING BLOCK is different: it is a property of the DOM tree plus the
// `position` values on it, both of which jsdom has. So everything below is the
// app's own — the real `CardFrame` Home renders, holding the real
// `ObjectContent` for a real obs-status mid-recording, which draws a real
// `Readout` with a real filled ground. Only the grid CELL around the frame is
// written out here, because mounting HomeGrid would need the whole Home data
// context: one `relative` div, which is the element the composition escaped to.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";

// The DOM has to exist before the component modules are evaluated — see
// number-input.test.tsx for why this is not a `before` hook.
import { installDom } from "../../test-dom.js";

const teardown = installDom();

// A widget's own SSE hooks open an EventSource on mount; jsdom has none, and
// this test feeds state through the render context instead.
class NoStream {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = NoStream;

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("../../main/layout-renderer.js");
const { makeRenderCtx } = await import("../../main/test-render-ctx.js");
const { CardFrame } = await import("./home-grid.js");
const { defaultStyle } = await import("../../main/layout-objects.js");

after(() => {
  cleanup();
  teardown();
});

const OBJ: LayoutObject =
  ({ id: "obs", x: 0, y: 0, w: 0.2, h: 0.12, z: 0, config: { type: "obs-status" }, style: defaultStyle("obs-status" as never) }) as never;

/** OBS mid-recording, on Home — the state that paints a filled ground. */
const RECORDING = makeRenderCtx({
  home: true,
  obs: { connected: true, recording: true, recordPaused: false, streaming: false, virtualCam: false, recordTimecode: "00:35:09" } as never,
});

/** The first ancestor a `position: absolute` child would resolve against. */
function containingBlockOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).position !== "static") return p;
  }
  return null;
}

/**
 * Home's cell → frame → widget: the `.home-card` grid cell, which is `relative`
 * because it carries the editor chrome in its corner and is what the
 * composition escaped to, holding the real CardFrame.
 */
function homeTile(): { frame: HTMLElement; composition: HTMLElement; ground: HTMLElement } {
  const { container } = render(
    React.createElement(
      "div",
      { className: "home-card relative", style: { position: "relative" } },
      React.createElement(
        CardFrame as never,
        { o: OBJ },
        React.createElement(ObjectContent as never, { o: OBJ, ctx: RECORDING }),
      ),
    ),
  );
  const cell = container.firstElementChild as HTMLElement;
  const frame = cell.firstElementChild as HTMLElement;
  // Positionally, not by selector. A readout renders a second aria-hidden span
  // for its meter, also a direct child of the composition, so
  // `querySelector('[aria-hidden]')` would be relying on document order to pick
  // the right one. The ground is the composition's FIRST child, and the assert
  // below says so rather than trusting the walk.
  const composition = frame.firstElementChild as HTMLElement;
  const ground = composition.firstElementChild as HTMLElement;
  assert.equal(
    ground?.getAttribute("aria-hidden"),
    "true",
    "the fixture is not drawing a filled ground, so it can prove nothing about one",
  );
  return { frame, composition, ground };
}

describe("a filled widget on Home", () => {
  test("resolves against the card frame, not the grid cell around it", () => {
    // THE guard. Make the frame static again and the composition resolves
    // against the cell — the frame's BORDER box — and the ground covers the
    // card's hairline on all four sides.
    const { frame, composition } = homeTile();
    assert.equal(getComputedStyle(composition).position, "absolute", "the composition stopped being absolute");
    assert.equal(
      containingBlockOf(composition),
      frame,
      "the filled ground resolves against the grid cell, so it paints over the card's border",
    );
    cleanup();
  });

  test("and still reaches the object's own edge", () => {
    // The bug the inset:0 exists for, and which this must not bring back: a
    // ground sized to the CONTENT box leaves the object's background drawing a
    // ring around it. The composition spans the frame and the ground spans the
    // composition, padding included, so the pair reach the frame's padding box.
    const { composition, ground } = homeTile();
    assert.equal(getComputedStyle(composition).inset, "0px", "the composition stopped covering the object's padding");
    assert.equal(getComputedStyle(ground).position, "absolute");
    assert.equal(getComputedStyle(ground).inset, "0px", "the ground stopped reaching the composition's edge");
    cleanup();
  });
});
