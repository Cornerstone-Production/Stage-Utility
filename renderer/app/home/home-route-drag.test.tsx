// Home's card drag, through the real HomeRoute: a second finger's press is not a second drag,
// and a drag still in flight when Home goes away leaves no listener on the window.
//
// NOT unit-tested here: how a dragged card looks. Driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown, mountInAct } from "../../test-dom.js";
import { NoStream } from "../../test-fixtures/no-stream.js";
import { serve } from "../../test-fixtures/button-server.js";

const teardown = installRenderDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterContextProvider, createRouter, createRootRoute, createMemoryHistory } = await import("@tanstack/react-router");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { HomeRoute } = await import("./home-route.js");
const { PageActionsProvider, PageActionsSlot } = await import("../page-actions.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const router = createRouter({ routeTree: createRootRoute({}), history: createMemoryHistory({ initialEntries: ["/"] }) });

const HOME = {
  id: "home",
  name: "Home",
  kind: "custom",
  createdAt: "2026-01-01T00:00:00.000Z",
  layoutRev: 1,
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null },
    objects: [{ id: "b1", x: 0, y: 0, w: 0.2, h: 0.2, z: 1, home: { size: "s", col: 1, row: 1 }, config: { type: "cue-button", cue: "", showDevice: true }, style: {} }],
  },
};

async function mountHome() {
  // The shared server answers the commands; the page's own state is stubbed on top of it.
  const server = serve({
    extra: (url) => (url.endsWith("/api/state") ? jsonOk({ ...DEFAULT_STAGE_STATE, views: [HOME], onboardingDismissed: true }) : undefined),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await mountInAct(render, 
    React.createElement(
      RouterContextProvider as never,
      { router },
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(TooltipProvider, null, React.createElement(PageActionsProvider, null, React.createElement(PageActionsSlot), React.createElement(HomeRoute)))),
    ),
  );
  await act(async () => settle());
  return () => server.restore();
}

const jsonOk = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) });


/** Pointer listeners on the window, live, by counting adds against removes. */
function trackWindowPointerListeners() {
  const live = new Map<unknown, string>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, fn: unknown, opts?: unknown) => {
    if (type.startsWith("pointer")) live.set(fn, type);
    return (add as (...a: unknown[]) => void)(type, fn, opts);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, fn: unknown, opts?: unknown) => {
    live.delete(fn);
    return (remove as (...a: unknown[]) => void)(type, fn, opts);
  }) as typeof window.removeEventListener;
  return {
    live: () => [...live.values()],
    restore: () => { window.addEventListener = add; window.removeEventListener = remove; },
  };
}

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>("div.cursor-grab");
  assert.ok(el, "no card overlay: edit mode did not open");
  // jsdom has no pointer capture.
  Object.assign(el, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
  return el;
}
const ptr = (pointerId: number, x: number, y = 0) => ({ pointerId, pointerType: "touch", button: 0, clientX: x, clientY: y });
const lifted = () => document.querySelector("div.cursor-grab")!.className.includes("ring-2");

async function edit() {
  fireEvent.click(await eventually(() => screen.getByLabelText("Edit widgets")));
  await act(async () => settle());
}

describe("the Home card drag", () => {
  test("a second finger's press does not start a second drag", async () => {
    const done = await mountHome();
    try {
      await edit();
      const el = overlay();
      fireEvent.pointerDown(el, ptr(1, 100));
      fireEvent.pointerDown(el, ptr(2, 100));
      await act(async () => { fireEvent.pointerMove(el, ptr(2, 140)); });
      assert.equal(lifted(), false, "the second finger lifted the card");
    } finally {
      done();
    }
  });

  test("the first finger still drags it", async () => {
    const done = await mountHome();
    try {
      await edit();
      const el = overlay();
      fireEvent.pointerDown(el, ptr(1, 100));
      await act(async () => { fireEvent.pointerMove(el, ptr(1, 140)); });
      assert.equal(lifted(), true, "the control is void: the owning finger lifted nothing");
    } finally {
      done();
    }
  });

  test("leaving Home mid-drag leaves nothing bound to the window", async () => {
    const t = trackWindowPointerListeners();
    const done = await mountHome();
    try {
      await edit();
      const el = overlay();
      fireEvent.pointerDown(el, ptr(1, 100));
      await act(async () => { fireEvent.pointerMove(el, ptr(1, 140)); });
      assert.ok(t.live().length > 0, "the control is void: the drag bound nothing");
      cleanup();
      assert.deepEqual(t.live(), [], "a dead Home's drag is still listening");
    } finally {
      t.restore();
      done();
    }
  });
});
