// Every kind reaches its own component, and a cycle draws a notice instead of
// hanging.
//
// Rendered, not reasoned about: the failure this guards is a box that renders
// nothing, or renders for ever. Neither shows up in a unit test over the pieces
// — the old `view-embed` had passing tests over its picker the whole time it was
// drawing "not embeddable yet" for four of the five kinds it offered.
//
// The FIRST version of this file guarded nothing. It asserted only that the box
// was non-empty and did not contain "not embeddable yet", which every refusal
// notice also satisfies — so five of the seven fixtures never reached a
// component at all, and stubbing the whole switch out kept the suite green. Each
// kind now gets a fixture that reaches its component and is asserted on a string
// only that component emits.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// React runs act() quietly only when told it is in a test environment; without
// this every awaited render logs "not configured to support act(...)".
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom does no layout, so every element measures 0 — and the embed sizes its
 * child's canvas by MEASURING its rendered box. One height for every element is
 * enough: the only assertion that reads it is the box-sizing test below, and it
 * cares that the number came from the box rather than from the object's
 * fraction of a canvas.
 */
const BOX_PX = 270;
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  get: () => BOX_PX,
  configurable: true,
});

// jsdom ships neither, and both are reached by a render: the state hooks open
// the state stream, and every view fetches on mount. Left real, a request
// outlives the test and settles after teardown has removed `window`, which
// surfaces as the FILE failing while every test in it passes.
class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");

const SLOT: Slot = {
  id: "s-1",
  channel: "1",
  order: 0,
  link: { kind: "static", label: "SLOT LABEL", color: "#888888" },
  device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null,
    charge: null, iemCharge: null, label: null, iemLabel: null },
};

/** A view that embeds ITSELF — the case only the real LayoutRenderer can check. */
const SELF_VIEW: View = {
  id: "v-self",
  name: "Self",
  kind: "custom",
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null, fit: "contain" },
    objects: [
      { id: "t-self", x: 0, y: 0, w: 1, h: 0.2, z: 0,
        config: { type: "text", text: "SELF BODY" }, style: { fontSize: 0.1 } },
      { id: "o-self", x: 0, y: 0.2, w: 1, h: 0.8, z: 1,
        config: { type: "view-embed", viewId: "v-self" } },
    ],
  },
};

/** Enough StageState for every view to hydrate and draw its real content. */
const STATE: StageState = {
  ...DEFAULT_STAGE_STATE,
  views: [SELF_VIEW],
  outputs: [{ id: "d-1", name: "Left Screen", viewId: null }],
  slotsByView: { "v-1": [SLOT] },
  pcoConfigured: true,
};
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const u = String(url);
  const body = u.includes("/api/state") ? STATE : u.includes("transcript") ? [] : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, screen, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { EmbeddedView } = await import("./embedded-view.js");
const { RenderObject, LayoutRenderer } = await import("./layout-renderer.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => cleanup());
afterEach(async () => { cleanup(); await settle(); });

/** The app wraps everything in a TooltipProvider; three of the views render a
 *  Tooltip and throw without one. */
async function draw(element: React.ReactElement) {
  let container!: HTMLElement;
  await act(async () => {
    container = render(React.createElement(TooltipProvider as never, null, element)).container;
    await settle();
  });
  return container;
}

function ctxWith(embedChain: string[]) {
  return makeRenderCtx({ state: STATE, embedChain });
}

const view = (kind: string, id = "v-1") => ({
  id, name: "Test view", kind,
  layout: { objects: [
    { id: "t1", type: "text", x: 0, y: 0, w: 1, h: 1, z: 0,
      config: { type: "text", text: "CUSTOM BODY" }, style: { fontSize: 0.1 } },
  ] },
}) as never;

describe("a cycle is refused, not rendered", () => {
  test("a view already above this one draws a notice", async () => {
    // Without this the render recurses until the tab dies — on a wall display
    // with nobody standing next to it.
    await draw(React.createElement(EmbeddedView, { view: view("custom", "v-1"), ctx: ctxWith(["v-1"]) } as never));
    assert.ok(screen.getByText(/cannot contain itself/i), "a self-embed did not draw a notice");
  });

  test("past the depth cap draws a notice", async () => {
    await draw(React.createElement(EmbeddedView, { view: view("custom", "v-9"), ctx: ctxWith(["a", "b", "c"]) } as never));
    assert.ok(screen.getByText(/nested more than/i), "unbounded nesting was allowed");
  });
});

describe("every kind reaches its own component", () => {
  /**
   * A string ONLY that kind's component can emit, so a tile that quietly drew a
   * notice instead — which is what five of these fixtures used to do — fails.
   * Deliberately not "the box is non-empty": every refusal notice passes that.
   */
  const MARKER: Record<string, RegExp> = {
    slots: /SLOT LABEL/,                 // the slot's own label, through SlotPanel
    dashboard: /Up next/,                // dashboard's panel heading
    stage: /Remaining slides/,           // the stage display's, and only its
    transcription: /Waiting for transcript/,
    custom: /CUSTOM BODY/,               // the embedded layout's own object
    script: /Planning Center not configured/, // ScriptView's own unconfigured state
    "spl-rundown": /Max SPL per item/,
  };

  for (const [kind, marker] of Object.entries(MARKER)) {
    test(`${kind} draws its component, not a notice`, async () => {
      const container = await draw(
        // displayId is what the per-display kinds need; the others ignore it.
        React.createElement(EmbeddedView, { view: view(kind), ctx: ctxWith([]), displayId: "d-1" } as never),
      );
      const text = container.textContent ?? "";
      assert.match(text, marker, `a ${kind} view did not reach its component (drew: ${text.slice(0, 120)})`);
      assert.equal(text.includes("not embeddable yet"), false, `a ${kind} view still says it is not embeddable`);
    });
  }
});

describe("a per-display kind says so rather than drawing an empty box", () => {
  for (const kind of ["dashboard", "stage", "spl-rundown"]) {
    test(`${kind} without a screen behind it`, async () => {
      await draw(React.createElement(EmbeddedView, { view: view(kind), ctx: ctxWith([]) } as never));
      assert.ok(screen.getByText(/set up per screen/i), `a ${kind} view with no display id drew nothing useful`);
    });
  }
});

describe("an embedded view is sized by its BOX, not by a fraction", () => {
  // The arithmetic that looks right — `o.h * ctx.H` — is right only for a
  // top-level object on a laid-out canvas. Here the embed is inside a CONTAINER,
  // where `o.h` is a fraction of the container and not of the canvas, so the
  // fraction says 1080 and the box is 270. Home is worse still: it does not use
  // the object's h to lay anything out at all.
  //
  // Inline font-size, not a class: jsdom loads no stylesheet, so a Tailwind class
  // resolves to nothing. This is a style attribute the renderer writes itself.
  test("an embed filling a half-height container gets the container's box", async () => {
    const ctx = ctxWith([]);
    (ctx as unknown as { state: { views: unknown[] } }).state = { ...STATE, views: [
      { id: "v-child", name: "Child", kind: "custom", layout: { objects: [
        { id: "t1", type: "text", x: 0, y: 0, w: 1, h: 1, z: 0,
          config: { type: "text", text: "Inner" }, style: { fontSize: 0.1 } },
      ] } },
    ] } as never;

    const container = {
      id: "c1", type: "container", x: 0, y: 0, w: 1, h: 0.5, z: 0,
      config: { type: "container" },
      children: [
        { id: "o-embed", type: "view-embed", x: 0, y: 0, w: 1, h: 1, z: 0,
          config: { type: "view-embed", viewId: "v-child" } },
      ],
    };
    await draw(React.createElement(RenderObject, { o: container, ctx } as never));

    const inner = screen.getByText("Inner") as HTMLElement;
    // The box measures BOX_PX, so a 0.1 font is 27px. `o.h * ctx.H` would give
    // 1 x 1080 -> 108px, and the parent's raw H would give the same.
    assert.equal(
      inner.style.fontSize,
      `${0.1 * BOX_PX}px`,
      "the embedded view sized its text off a fraction instead of its rendered box",
    );
  });
});

describe("the OUTERMOST view is on the chain too", () => {
  // Through the real LayoutRenderer, because this is the one part of the guard
  // no hand-built context can check: every other test in this file supplies the
  // chain itself, and so agrees with whatever the component does. Left unseeded,
  // a tile pointing back at the view it lives on was not a cycle — it drew a
  // second copy of the whole layout inside itself, and only the depth cap
  // stopped it. Seen in a browser, invisible to every unit test.
  test("a tile pointing at its own view draws the notice, not a second copy", async () => {
    await draw(React.createElement(LayoutRenderer, {
      layout: SELF_VIEW.layout, viewId: "v-self", ndiSource: null, interactive: false,
    } as never));

    assert.ok(screen.getByText(/cannot contain itself/i), "the view embedded itself without a notice");
    // Once, from the layout itself. Twice means the embed drew the whole view
    // again inside its own tile.
    assert.equal(screen.getAllByText("SELF BODY").length, 1, "the view was drawn inside itself");
  });
});
