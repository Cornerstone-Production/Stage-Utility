// The Timer is drawn from live data on the surfaces that build their own render
// context.
//
// timer-render.test.tsx hands ObjectContent a context it made itself, so it can
// never see whether a surface threads `pcoLiveKnown` and `propresenterKnown` into
// the one it BUILDS: forcing either flag false in home-grid.tsx, layout-renderer.tsx
// or layout-editor.tsx left the suite green, and every Timer on that surface would
// have drawn the plain dash for ever. These mount the real LayoutRenderer and the
// real HomeGrid over a stubbed server, with a live `pco:live` and ProPresenter
// timers reported, and assert the time is on the screen. (The editor canvas is in
// editor/layout-editor-timer.test.tsx.)

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom({ clientHeight: 240 });
for (const [prop, px] of [["offsetHeight", 240], ["offsetWidth", 520]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { LayoutRenderer } = await import("./layout-renderer.js");
const { HomeGrid } = await import("../app/home/home-grid.js");
const { DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

/** An item with ten minutes, two in: eight left. Stamped with the real clock when
 *  served, because the server clock is anchored to the stamp and ticks from there. */
const pcoLive = () => {
  const now = Date.now();
  return {
    mode: "item", currentItemId: "i1", label: "Message", lengthSec: 600,
    liveStartAt: new Date(now - 120_000).toISOString(),
    targetAt: null, serverNow: new Date(now).toISOString(), currentItemTitle: "Message", nextItemTitle: "Announcements",
    serviceTimeId: null, serviceTimeStartsAt: null,
  };
};
const PRO = { connected: true, timers: [{ name: "Stage", time: "00:03:00", state: "running" }] };

function serve() {
  return stubFetchWithLog((url) => {
    const path = url.split("?")[0];
    return path.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE)
      : path.endsWith("/api/pco/live") ? ok(pcoLive())
      : path.endsWith("/api/propresenter/status") ? ok(PRO)
      : path.endsWith("/api/propresenter/instances") ? ok({ list: [{ id: "default", name: "Main" }], conn: {}, status: { default: PRO } })
      : path.endsWith("/api/integrations") ? ok({ descriptors: [], states: [{ id: "propresenter", enabled: true, configured: true, connection: "connected", message: null, config: {} }] })
      : ok(null);
  });
}

const EIGHT_MINUTES = /(8:00|7:5\d)/;
const object = (id: string, config: Record<string, unknown>) =>
  ({ id, x: 0.05, y: 0.05, w: 0.4, h: 0.4, z: 1, config, style: {} }) as never;

async function draw(element: React.ReactElement): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    container = render(React.createElement(TooltipProvider as never, null, element)).container;
    await settle();
    await settle();
  });
  return container;
}

describe("the real LayoutRenderer", () => {
  const layout = (...objects: unknown[]) => ({ version: 1, canvas: { width: 1920, height: 1080, background: null }, objects }) as never;

  test("draws a service Timer's time from pco:live", async () => {
    const f = serve();
    try {
      const c = await draw(React.createElement(LayoutRenderer, { layout: layout(object("a", { type: "timer", source: "service" })) } as never));
      await eventually(() => assert.match(c.textContent ?? "", EIGHT_MINUTES, `the service Timer never drew its time: "${c.textContent}"`));
    } finally {
      f.restore();
    }
  });

  test("draws a ProPresenter Timer's time from the reported timers", async () => {
    const f = serve();
    try {
      const c = await draw(React.createElement(LayoutRenderer, { layout: layout(object("b", { type: "timer", source: "propresenter" })) } as never));
      await eventually(() => assert.match(c.textContent ?? "", /00:03:00/, `the ProPresenter Timer never drew its time: "${c.textContent}"`));
    } finally {
      f.restore();
    }
  });
});

describe("the real HomeGrid", () => {
  const home = (...cards: unknown[]) =>
    React.createElement(HomeGrid, {
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: cards } as never,
      cards: cards as never,
    } as never);

  test("draws a service Timer card's time", async () => {
    const f = serve();
    try {
      const c = await draw(home(object("a", { type: "timer", source: "service", nextItem: true })));
      await eventually(() => assert.match(c.textContent ?? "", EIGHT_MINUTES, `the Home Timer never drew its time: "${c.textContent}"`));
    } finally {
      f.restore();
    }
  });

  test("draws a ProPresenter Timer card's time", async () => {
    const f = serve();
    try {
      const c = await draw(home(object("b", { type: "timer", source: "propresenter" })));
      await eventually(() => assert.match(c.textContent ?? "", /00:03:00/, `the Home ProPresenter Timer never drew its time: "${c.textContent}"`));
    } finally {
      f.restore();
    }
  });
});
