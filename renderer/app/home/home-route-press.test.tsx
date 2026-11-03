// Home's route wires a Button's tile to the Presses sheet: tapping an unset Button opens it, and
// the card menu's Presses… opens it too.
//
// Through the real HomeRoute over a stubbed server: home-grid.tsx hands a tile its way in only when
// the route gives the grid one, and nothing below the route can tell if that wiring is gone: a
// route that forgot it leaves a tile that reads "Choose what it presses" and does nothing.
//
// NOT unit-tested here: how the sheet looks. Driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { NoStream } from "../../test-fixtures/no-stream.js";
import { serve } from "../../test-fixtures/button-server.js";

const teardown = installRenderDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterContextProvider, createRouter, createRootRoute, createMemoryHistory } = await import("@tanstack/react-router");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { HomeRoute } = await import("./home-route.js");
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
  render(
    React.createElement(
      RouterContextProvider as never,
      { router },
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(TooltipProvider, null, React.createElement(HomeRoute))),
    ),
  );
  await act(async () => settle());
  return () => server.restore();
}

const jsonOk = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) });

describe("Home's route and a Button tile", () => {
  test("tapping an unset Button opens the Presses sheet for it", async () => {
    const done = await mountHome();
    try {
      const tile = await eventually(() => screen.getByText("Choose what it presses"));
      fireEvent.click(tile);
      await eventually(() => assert.ok(screen.getByText("What this tile presses")));
    } finally {
      done();
    }
  });

  test("the card menu's Presses… opens it too", async () => {
    const done = await mountHome();
    try {
      const tile = await eventually(() => screen.getByText("Choose what it presses"));
      fireEvent.contextMenu(tile.closest("[data-card-id]")!);
      fireEvent.click(await eventually(() => screen.getByRole("menuitem", { name: /Presses/ })));
      await eventually(() => assert.ok(screen.getByText("What this tile presses")));
    } finally {
      done();
    }
  });
});
