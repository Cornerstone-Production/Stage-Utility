// A screen tile shows what that screen is showing, and NAMES every reason it is
// not showing anything.
//
// The failure this guards is a tile that draws an empty box. Unrouted, deleted
// and blacked out all look identical when nothing says which one happened — at
// the moment somebody is stood at a producer desk working out what is wrong with
// a screen. So each test below asserts on a string ONLY that branch emits, and
// on the marker of the routed view where a view should be drawn. "The box is
// non-empty" is not an assertion: every notice satisfies it, which is how a
// previous embed suite stayed green with the whole component stubbed out.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../test-dom.js";

// See installRenderDom for the act flag, the clientHeight and the EventSource
// stub, which this file and two of its neighbours each wrote out verbatim.
// jsdom does no layout, so the real clientHeight is 0 and this tile sizes its
// child's canvas by MEASURING its body.
const BOX_PX = 270;
const teardown = installRenderDom({ clientHeight: BOX_PX });

/** The routed view draws this and nothing else does, so "the tile drew the view"
 *  is checkable rather than inferred from the box being non-empty. */
const VIEW_MARKER = "ROUTED VIEW BODY";

const ROUTED_VIEW: View = {
  id: "v-1",
  name: "Slots A",
  kind: "custom",
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, fit: "contain" },
    objects: [
      { id: "t1", x: 0, y: 0, w: 1, h: 1, z: 0,
        config: { type: "text", text: VIEW_MARKER }, style: { fontSize: 0.1 } },
    ],
  },
};
const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { RenderObject } = await import("./layout-renderer.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");

const STATE: StageState = { ...DEFAULT_STAGE_STATE, views: [ROUTED_VIEW], outputs: [] };
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const u = String(url);
  const body = u.includes("/api/state") ? STATE : u.includes("transcript") ? [] : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => cleanup());
afterEach(async () => { cleanup(); await settle(); });

/** The app wraps everything in a TooltipProvider; several of the views render a
 *  Tooltip and throw without one. */
async function draw(element: React.ReactElement) {
  let container!: HTMLElement;
  await act(async () => {
    container = render(React.createElement(TooltipProvider as never, null, element)).container;
    await settle();
  });
  return container;
}

function ctxWith(outputs: Output[], views: View[] = [ROUTED_VIEW], embedChain: string[] = []) {
  return makeRenderCtx({ state: { ...STATE, outputs, views }, embedChain });
}

/** The tile as the renderer builds it, through the real RenderObject — so the
 *  registry entry, the switch case and the component are all on the path. */
const tile = (config: Record<string, unknown>) => ({
  id: "o1", type: "screen-embed", x: 0, y: 0, w: 1, h: 1, z: 1,
  config: { type: "screen-embed", ...config },
  style: {},
});

describe("a screen tile", () => {
  test("draws the view the screen is CURRENTLY routed to", async () => {
    const container = await draw(React.createElement(RenderObject, {
      o: tile({ outputId: "out-1", showLabel: true }),
      ctx: ctxWith([{ id: "out-1", name: "Left Display", viewId: "v-1" }]),
    } as never));
    const text = container.textContent ?? "";
    assert.match(text, /Left Display/, "the tile did not name the screen");
    assert.match(text, new RegExp(VIEW_MARKER), "the tile did not draw the routed view's own content");
  });

  test("follows the routing when it changes, without the layout changing", async () => {
    // The whole difference from view-embed. Same object, same config; only the
    // OUTPUT moved, and the tile has to move with it.
    const other: View = {
      id: "v-2", name: "Other", kind: "custom", createdAt: "2026-01-01T00:00:00.000Z",
      layout: {
        version: 1,
        canvas: { width: 1920, height: 1080, fit: "contain" },
        objects: [
          { id: "t2", x: 0, y: 0, w: 1, h: 1, z: 0,
            config: { type: "text", text: "SECOND VIEW BODY" }, style: { fontSize: 0.1 } },
        ],
      },
    };
    const o = tile({ outputId: "out-1" });
    const routed = (viewId: string) =>
      React.createElement(TooltipProvider as never, null,
        React.createElement(RenderObject, {
          o, ctx: ctxWith([{ id: "out-1", name: "Left Display", viewId }], [ROUTED_VIEW, other]),
        } as never));

    // The SAME mounted tree, re-rendered with new routing — not a fresh mount,
    // which would pass for a tile that read the routing once and cached it.
    let result!: { container: HTMLElement; rerender: (el: React.ReactElement) => void };
    await act(async () => { result = render(routed("v-1")) as never; await settle(); });
    assert.match(result.container.textContent ?? "", new RegExp(VIEW_MARKER));

    await act(async () => { result.rerender(routed("v-2")); await settle(); });
    const text = result.container.textContent ?? "";
    assert.match(text, /SECOND VIEW BODY/, "the tile stayed on the view it first drew");
    assert.equal(text.includes(VIEW_MARKER), false, "the tile drew both views at once");
  });

  test("says so when the screen is not routed anywhere", async () => {
    const container = await draw(React.createElement(RenderObject, {
      o: tile({ outputId: "out-1" }),
      ctx: ctxWith([{ id: "out-1", name: "Left Display", viewId: null }]),
    } as never));
    const text = container.textContent ?? "";
    // The screen's own name inside the sentence — an unrouted screen is a thing
    // somebody has to go and fix, and "nothing here" does not say which one.
    assert.match(text, /"Left Display" is not showing anything/,
      `an unrouted screen did not name itself (drew: ${text.slice(0, 120)})`);
    assert.equal(text.includes(VIEW_MARKER), false, "an unrouted screen drew a view anyway");
  });

  test("says so when the screen is blacked out, rather than drawing the view", async () => {
    // A blacked-out screen shows black. A tile that draws the routed view anyway
    // tells a producer the opposite of what the room can see.
    const container = await draw(React.createElement(RenderObject, {
      o: tile({ outputId: "out-1" }),
      ctx: ctxWith([{ id: "out-1", name: "Left Display", viewId: "v-1", blackout: true }]),
    } as never));
    const text = container.textContent ?? "";
    assert.match(text, /Blackout/, `a blacked-out screen did not say so (drew: ${text.slice(0, 120)})`);
    // The half that actually catches the bug: without the blackout branch the
    // routed view renders, and the word "Blackout" is nowhere — but a tile that
    // said "Blackout" AND drew the view would still be lying.
    assert.equal(text.includes(VIEW_MARKER), false, "a blacked-out screen drew its routed view");
  });

  // The status dot lives in display-presence-wiring.test.tsx. It stopped being a
  // property of what the tile is SHOWING when it started meaning "a browser is
  // attached", and the states it reads are presence states, not routing ones.

  test("says so when the screen was deleted", async () => {
    const container = await draw(React.createElement(RenderObject, {
      o: tile({ outputId: "gone" }),
      ctx: ctxWith([]),
    } as never));
    assert.match(container.textContent ?? "", /no longer exists/,
      "a tile pointing at a deleted screen drew nothing useful");
  });

  test("says so before a screen has been picked", async () => {
    const container = await draw(React.createElement(RenderObject, {
      o: tile({ outputId: null }),
      ctx: ctxWith([{ id: "out-1", name: "Left Display", viewId: "v-1" }]),
    } as never));
    const text = container.textContent ?? "";
    assert.match(text, /Pick a screen/, `a freshly placed tile drew nothing useful (drew: ${text.slice(0, 120)})`);
    // A tile with no screen chosen must not name one either.
    assert.equal(text.includes("Left Display"), false, "an unconfigured tile named a screen it is not bound to");
  });
});

describe("the tile sizes its child by its own BODY", () => {
  // The arithmetic that looks right — `o.h * ctx.H` — is right only for a
  // top-level object on a laid-out canvas, and it is wrong here twice over: the
  // tile may be inside a container, and the label bar eats height off the top.
  //
  // Inline font-size, not a class: jsdom loads no stylesheet, so a Tailwind class
  // resolves to nothing. This is a style attribute the renderer writes itself.
  test("the routed view is drawn against the measured box, not the parent canvas", async () => {
    const container = await draw(React.createElement(RenderObject, {
      o: tile({ outputId: "out-1" }),
      ctx: ctxWith([{ id: "out-1", name: "Left Display", viewId: "v-1" }]),
    } as never));
    // The INNERMOST match. Elements holding this text are an ancestor chain, and
    // the outermost of them is the tile's own wrapper, whose font size is the
    // object's style against the canvas — a different number that happens to be
    // there. The text object is the last one in document order.
    const inner = [...container.querySelectorAll("*")].filter(
      (el) => el.textContent === VIEW_MARKER && (el as HTMLElement).style.fontSize,
    ).at(-1) as HTMLElement | undefined;
    assert.ok(inner, "the routed view's text object was not rendered");
    // The body measures BOX_PX, so a 0.1 font is 27px. ctx.H would give 108px.
    assert.equal(
      inner.style.fontSize,
      `${0.1 * BOX_PX}px`,
      "the screen tile sized its child off the parent canvas instead of its own body",
    );
  });
});

describe("a screen tile cannot show the view it lives on", () => {
  test("a tile bound to the screen showing this very view draws a notice", async () => {
    // Straight off a producer wall: point a tile at the screen you are building
    // the wall on. Without the embed chain the tile draws the whole wall inside
    // itself, once per level, until the depth cap stops it.
    const container = await draw(React.createElement(RenderObject, {
      o: tile({ outputId: "out-1" }),
      ctx: ctxWith([{ id: "out-1", name: "Left Display", viewId: "v-1" }], [ROUTED_VIEW], ["v-1"]),
    } as never));
    const text = container.textContent ?? "";
    assert.match(text, /cannot contain itself/i, "a self-referencing screen tile was not refused");
    assert.equal(text.includes(VIEW_MARKER), false, "the view was drawn inside itself");
  });
});
