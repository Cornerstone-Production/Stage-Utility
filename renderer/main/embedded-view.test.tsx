// Every kind draws something, and a cycle draws a notice instead of hanging.
//
// Rendered, not reasoned about: the failure this guards is a box that renders
// nothing, or renders for ever. Neither shows up in a unit test over the pieces
// — the old `view-embed` had passing tests over its picker the whole time it was
// drawing "not embeddable yet" for four of the five kinds it offered.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// React only runs act() quietly when it is told it is in a test environment;
// without this every awaited render logs "not configured to support act(...)".
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships neither, and both are reached by a render: the state hooks open
// the state stream, and several views fetch on mount. Left real, a request
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
const SELF_VIEW = {
  id: "v-self",
  name: "Self",
  kind: "custom",
  createdAt: "2026-01-01T00:00:00.000Z",
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null, fit: "letterbox" },
    objects: [
      { id: "t-self", type: "text", x: 0, y: 0, w: 1, h: 0.2, z: 0,
        config: { type: "text", text: "SELF BODY" }, style: { fontSize: 0.1 } },
      { id: "o-self", type: "view-embed", x: 0, y: 0.2, w: 1, h: 0.8, z: 1,
        config: { type: "view-embed", viewId: "v-self" } },
    ],
  },
};

/** Enough StageState for LayoutRenderer to hydrate; `/api/state` is the only
 *  route it needs, and every other fetch answers with an empty object. */
const STATE = { views: [SELF_VIEW], outputs: [], slotsByView: {}, slotsByLayoutObject: {},
  emptySlotLogo: null, defaultAvatar: null, hourCycle: "24h" };
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const body = String(url).includes("/api/state") ? STATE : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, screen, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { EmbeddedView } = await import("./embedded-view.js");
const { RenderObject, LayoutRenderer } = await import("./layout-renderer.js");
const { act } = await import("react");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => cleanup());
afterEach(async () => { cleanup(); await settle(); });

function ctxWith(embedChain: string[]) {
  return {
    state: { views: [], outputs: [], slotsByView: {}, slotsByLayoutObject: {} },
    propresenter: null, propInstances: [], pcoLive: null, planItems: null,
    transcript: [], spl: null, obs: null, reaper: null, resi: null, youtube: null,
    osc: null, peopleCount: null, serviceLow: null, serviceAttendance: null,
    servicePeak: null, servicePeakAttendance: null, baptism: null,
    serviceTimeline: null, integrations: [], integrationLabels: {}, wireless: [],
    now: 0, skewMs: 0, ndiSource: null, H: 1080, placed: undefined,
    home: false, interactive: false, embedChain,
  } as never;
}

const view = (kind: string, id = "v-1") => ({ id, name: "Test view", kind, layout: { objects: [] } }) as never;

describe("a cycle is refused, not rendered", () => {
  test("a view already above this one draws a notice", () => {
    // Without this the render recurses until the tab dies — on a wall display
    // with nobody standing next to it.
    render(React.createElement(EmbeddedView, { view: view("custom", "v-1"), ctx: ctxWith(["v-1"]) } as never));
    assert.ok(screen.getByText(/cannot contain itself/i), "a self-embed did not draw a notice");
  });

  test("past the depth cap draws a notice", () => {
    render(React.createElement(EmbeddedView, { view: view("custom", "v-9"), ctx: ctxWith(["a", "b", "c"]) } as never));
    assert.ok(screen.getByText(/nested more than/i), "unbounded nesting was allowed");
  });
});

describe("every kind draws something", () => {
  for (const kind of ["slots", "dashboard", "stage", "transcription", "custom", "script", "spl-rundown"]) {
    test(`${kind} is not an empty box`, () => {
      const { container } = render(
        React.createElement(EmbeddedView, { view: view(kind), ctx: ctxWith([]) } as never),
      );
      // Not asserting WHAT it drew — each kind is its own component with its own
      // tests. Asserting that the embed reached one at all, which is exactly what
      // four kinds failed to do before this.
      assert.ok(
        (container.textContent ?? "").trim().length > 0 || container.querySelector("div, svg"),
        `a ${kind} view rendered an empty box`,
      );
      assert.equal(
        (container.textContent ?? "").includes("not embeddable yet"),
        false,
        `a ${kind} view still says it is not embeddable`,
      );
      cleanup();
    });
  }
});

describe("an embedded custom view is drawn to the BOX, not the screen", () => {
  // Through RenderObject, so this exercises the real `view-embed` case rather
  // than a component called with hand-made arguments. Everything that sizes
  // itself in a layout is a fraction of ctx.H; handing the child the parent's H
  // drew a quarter-height tile's contents four times too large, which is markup
  // that looks right and output nobody can read.
  //
  // Inline font-size, not a class: jsdom loads no stylesheet, so a Tailwind class
  // resolves to nothing. This is a style attribute the renderer writes itself.
  const child = {
    id: "v-child",
    name: "Child",
    kind: "custom",
    layout: {
      canvas: { width: 1920, height: 1080 },
      objects: [
        { id: "t1", type: "text", x: 0, y: 0, w: 1, h: 1, z: 0,
          config: { type: "text", text: "Inner" }, style: { fontSize: 0.1 } },
      ],
    },
  };

  test("a quarter-height tile sizes its child's text to the tile", () => {
    const ctx = ctxWith([]);
    (ctx as unknown as { state: { views: unknown[] } }).state.views = [child];
    const embed = {
      id: "o-embed", type: "view-embed", x: 0, y: 0, w: 1, h: 0.25, z: 0,
      config: { type: "view-embed", viewId: "v-child" },
    };
    render(React.createElement(RenderObject, { o: embed, ctx } as never));

    const inner = screen.getByText("Inner");
    // H is 1080 and the box is a quarter of it, so the child's canvas is 270 and
    // a 0.1 font is 27px. The parent's H would have given 108.
    assert.equal(
      (inner as HTMLElement).style.fontSize,
      "27px",
      "the embedded view sized its text to the screen instead of to its box",
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
    const layout = SELF_VIEW.layout;
    await act(async () => {
      render(React.createElement(LayoutRenderer, {
        layout, viewId: "v-self", ndiSource: null, interactive: false,
      } as never));
      await settle();
    });

    assert.ok(screen.getByText(/cannot contain itself/i), "the view embedded itself without a notice");
    // Once, from the layout itself. Twice means the embed drew the whole view
    // again inside its own tile.
    assert.equal(screen.getAllByText("SELF BODY").length, 1, "the view was drawn inside itself");
  });
});
