// Which surfaces get a tile's action, through the real renderer.
//
// The same Recording and Timer cards are drawn on a wall, where a press does
// nothing and a button would be a lie painted for an audience. Only Home, for an
// operator, draws them; Streaming never does.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("../../main/layout-renderer.js");
const { makeRenderCtx } = await import("../../main/test-render-ctx.js");

after(() => unmountAndTeardown(cleanup, teardown));

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/reaper/status"))
      return ok({ connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: null, positionString: null });
    if (url.endsWith("/api/obs/status")) return ok({ connected: false, recording: false });
    return ok({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const obj = (config: unknown, home?: unknown) =>
  ({ id: "c", x: 0, y: 0, w: 1, h: 1, z: 1, config, style: {}, ...(home ? { home } : {}) }) as never;

const live = { mode: "item", currentItemId: "i", label: "Hold Fast", lengthSec: 300, liveStartAt: new Date(0).toISOString(), targetAt: null, serverNow: new Date(0).toISOString(), currentItemTitle: "Hold Fast", nextItemTitle: "Message", serviceTimeId: null, serviceTimeStartsAt: null } as never;

describe("Recording", () => {
  test("Start is on the tile on Home, for an operator", async () => {
    render(React.createElement(ObjectContent, { o: obj({ type: "home-recording" }), ctx: makeRenderCtx({ home: true, interactive: true }) }));
    await settle();
    await eventually(() => assert.ok(screen.getByRole("button", { name: "Start" })));
  });

  test("a wall draws no button", async () => {
    render(React.createElement(ObjectContent, { o: obj({ type: "home-recording" }), ctx: makeRenderCtx({ home: false, interactive: false }) }));
    await settle();
    await settle();
    assert.ok(screen.queryByRole("button") === null);
  });

  test("a Home that is not interactive (the editor's preview) draws no button", async () => {
    render(React.createElement(ObjectContent, { o: obj({ type: "home-recording" }), ctx: makeRenderCtx({ home: true, interactive: false }) }));
    await settle();
    await settle();
    assert.ok(screen.queryByRole("button") === null);
  });
});

describe("Streaming has no action, on purpose", () => {
  test("not even on Home", async () => {
    render(React.createElement(ObjectContent, { o: obj({ type: "home-streaming" }), ctx: makeRenderCtx({ home: true, interactive: true }) }));
    await settle();
    await settle();
    assert.ok(screen.queryByRole("button") === null);
  });
});

describe("the service Timer", () => {
  const timer = { type: "timer", source: "service", nextItem: true };

  test("carries Next, and Prev from medium up", async () => {
    render(React.createElement(ObjectContent, { o: obj(timer, { size: "xl", when: "live" }), ctx: makeRenderCtx({ home: true, interactive: true, pcoLive: live, now: 1000 }) }));
    assert.ok(screen.getByRole("button", { name: /Next/ }));
    assert.ok(screen.getByRole("button", { name: /Prev/ }));
  });

  test("a small tile carries Next alone", () => {
    render(React.createElement(ObjectContent, { o: obj(timer, { size: "s", when: "live" }), ctx: makeRenderCtx({ home: true, interactive: true, pcoLive: live, now: 1000 }) }));
    assert.ok(screen.getByRole("button", { name: /Next/ }));
    assert.ok(screen.queryByRole("button", { name: /Prev/ }) === null);
  });

  test("with no service live there is nothing to step", () => {
    render(React.createElement(ObjectContent, { o: obj(timer, { size: "xl", when: "live" }), ctx: makeRenderCtx({ home: true, interactive: true, pcoLive: null }) }));
    assert.ok(screen.queryByRole("button") === null);
  });

  test("a wall draws no buttons, even for the retired live-status card that draws this Stat there", () => {
    // `home-live-status` is the one Timer that draws Home's Stat OFF Home; a
    // plain Timer on a wall is a readout and never reaches this branch.
    render(React.createElement(ObjectContent, { o: obj({ type: "home-live-status" }), ctx: makeRenderCtx({ home: false, interactive: false, pcoLive: live, now: 1000 }) }));
    assert.ok(screen.queryByRole("button") === null);
  });

  test("a Home that is not interactive (the editor's preview) draws no buttons", () => {
    render(React.createElement(ObjectContent, { o: obj(timer, { size: "xl", when: "live" }), ctx: makeRenderCtx({ home: true, interactive: false, pcoLive: live, now: 1000 }) }));
    assert.ok(screen.queryByRole("button") === null);
  });
});

describe("Screens keeps its link where it does not expand", () => {
  const screens = { type: "home-screens" };
  async function mountScreens(home: boolean) {
    const { RouterContextProvider } = await import("@tanstack/react-router");
    const { routerAt } = await import("../../test-fixtures/router.js");
    render(
      React.createElement(RouterContextProvider, {
        router: routerAt("/", "/", "/screens"),
        children: React.createElement(ObjectContent, { o: obj(screens), ctx: makeRenderCtx({ home, interactive: true }) }),
      }),
    );
    await settle();
  }

  test("on a console it links to /screens", async () => {
    await mountScreens(false);
    assert.equal(screen.getByRole("link").getAttribute("href"), "/screens");
  });

  test("on Home it does not: the tile expands and the panel carries Open Screens", async () => {
    await mountScreens(true);
    assert.ok(screen.queryByRole("link") === null);
  });
});
