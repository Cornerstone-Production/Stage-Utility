// A Home card opens over the page, and a control inside it still works.
//
// The failure this guards twice shipped in this repository: an expand affordance
// wrapped around a tile's content, swallowing the presses of the controls inside
// it. Here the "card" holds a real button, and the press on it must be the
// button's and must not open the panel.
//
// jsdom does no layout and no hit-testing, so this cannot prove the corner
// control is not painted OVER the body. That is checked in a browser.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import type { DeviceStatus } from "@main/types/devices";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();
const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { RouterContextProvider } = await import("@tanstack/react-router");
const { routerAt } = await import("../../../test-fixtures/router.js");
const { makeRenderCtx } = await import("../../../main/test-render-ctx.js");
const { ExpandableTile, pressIsControls } = await import("./expandable-tile.js");
const { ok, stubFetchWithLog } = await import("../../../test-fixtures/fetch-log.js");

const PLAN = {
  planId: "p1",
  noteCategories: [],
  items: [
    { id: "h", title: "Service", itemType: "header", lengthSec: 0, sequence: 1, notesByCategory: {}, description: null },
    { id: "i1", title: "Welcome", itemType: "item", lengthSec: 360, sequence: 2, notesByCategory: {}, description: null },
    { id: "i2", title: "Hold Fast", itemType: "song", lengthSec: 252, sequence: 3, notesByCategory: {}, description: null },
    { id: "i3", title: "Message", itemType: "item", lengthSec: 1920, sequence: 4, notesByCategory: {}, description: null },
  ],
};
const TIMELINE = { serviceKey: "k", endedAt: null, items: [{ itemId: "i1", title: "Welcome", actualDurationSec: 400, plannedLengthSec: 360 }] };

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const obj = (config: unknown): LayoutObject =>
  ({ id: "x", x: 0, y: 0, w: 1, h: 1, z: 1, config, style: {} }) as unknown as LayoutObject;

const dev = (over: Partial<DeviceStatus>): DeviceStatus =>
  ({
    channelId: "c1", name: "Pastor", deviceType: "receiver", online: true, rfBars: 5, rfLevelDbm: null,
    battery: 92, batteryMinutes: 220, charging: null, frequencyLabel: null, audioLevel: null,
    cycles: null, health: null, tempC: null, updatedAt: "", ...over,
  }) as DeviceStatus;

function mount(config: unknown, opts: { interactive?: boolean; editing?: boolean; onInner?: () => void; currentItemId?: string } = {}) {
  const router = routerAt("/", "/", "/mic-slots", "/screens", "/plan", "/history/manage");
  const ctx = makeRenderCtx({
    home: true,
    interactive: opts.interactive ?? true,
    pcoLive: opts.currentItemId ? ({ currentItemId: opts.currentItemId } as never) : null,
    wireless: [dev({}), dev({ channelId: "c2", name: "Handheld 3", battery: 19, batteryMinutes: 40 }),
      dev({ channelId: "c3", name: "Acoustic DI", muted: true }), dev({ channelId: "c4", name: "Spare lav", online: false, battery: null })],
  });
  render(
    React.createElement(RouterContextProvider, {
      router,
      children: React.createElement(
        ExpandableTile,
        {
          o: obj(config),
          ctx,
          editing: opts.editing ?? false,
          children: React.createElement("div", { "data-testid": "body" }, "tile body",
            React.createElement("button", { type: "button", onClick: opts.onInner }, "inner")),
        },
      ),
    }),
  );
  return router;
}

const panel = () => document.querySelector("[data-expand-overlay]");

test("the corner control opens the panel and Close shuts it", async () => {
  mount({ type: "wireless-summary" });
  assert.ok(panel() === null);
  fireEvent.click(screen.getByRole("button", { name: "Expand Wireless" }));
  await settle();
  assert.ok(panel() !== null, "the panel is open");
  fireEvent.click(screen.getByRole("button", { name: "Close Wireless" }));
  await settle();
  // The Close press bubbles through the React tree to the card's own press
  // handler. If that reads it as a press on the card, the panel reopens.
  assert.ok(panel() === null, "Close must leave it closed");
});

test("pressing the body of a card with no controls of its own opens it", async () => {
  mount({ type: "wireless-summary" });
  fireEvent.click(screen.getByTestId("body"));
  await settle();
  assert.ok(panel() !== null);
});

test("a control inside the card keeps its own press and does not open the panel", async () => {
  let pressed = 0;
  mount({ type: "wireless-summary" }, { onInner: () => pressed++ });
  fireEvent.click(screen.getByRole("button", { name: "inner" }));
  await settle();
  assert.equal(pressed, 1, "the button's own handler ran");
  assert.ok(panel() === null, "and the card did not also expand");
});

test("a card that holds controls expands only from the corner", async () => {
  const f = stubFetchWithLog(() => ok({ items: [], noteCategories: [], planId: null }));
  after(() => f.restore());
  mount({ type: "timer", source: "service", nextItem: true });
  fireEvent.click(screen.getByTestId("body"));
  await settle();
  assert.ok(panel() === null, "a press on the body is left alone");
  fireEvent.click(screen.getByRole("button", { name: "Expand Service order" }));
  await settle();
  await settle();
  assert.ok(panel() !== null);
});

test("the rundown panel marks the current item and sets planned against actual", async () => {
  const f = stubFetchWithLog((url) =>
    url.includes("/api/pco/plan-items") ? ok(PLAN) : url.includes("/api/service-timeline") ? ok(TIMELINE) : ok({}),
  );
  try {
    mount({ type: "timer", source: "service", nextItem: true }, { currentItemId: "i2" });
    fireEvent.click(screen.getByRole("button", { name: "Expand Service order" }));
    await settle();
    await eventually(() => assert.ok(panel()?.querySelectorAll("[data-row]").length === 3));
    const rows = [...(panel() as HTMLElement).querySelectorAll("[data-row]")];
    assert.match(rows[0]?.textContent ?? "", /Welcome.*6:40 \/ 6:00/, "actual over planned for an item that has run");
    assert.equal(rows[1]?.getAttribute("aria-current"), "true", "the live item is marked");
    assert.match(rows[1]?.textContent ?? "", /Hold Fast.*now/);
    assert.equal(rows[0]?.getAttribute("aria-current"), null);
    assert.match(rows[2]?.textContent ?? "", /Message.*32:00/, "planned only, for one still to come");
    assert.ok((panel() as HTMLElement).textContent?.includes("Service"), "section headers are kept");
  } finally {
    f.restore();
  }
});

test("a rundown that cannot be read says so, not that there is no plan", async () => {
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/pco/plan-items")) throw new TypeError("fetch failed");
    return ok({});
  });
  try {
    mount({ type: "timer", source: "service", nextItem: true });
    fireEvent.click(screen.getByRole("button", { name: "Expand Service order" }));
    await settle();
    await eventually(() => assert.match(panel()?.textContent ?? "", /Couldn't load the plan/));
  } finally {
    f.restore();
  }
});

test("a card with no expanded body is drawn as it always was", () => {
  mount({ type: "home-recording" });
  assert.ok(screen.queryByRole("button", { name: /Expand/ }) === null);
  assert.ok(screen.getByTestId("body"));
});

test("while Home is being edited, nothing expands", async () => {
  mount({ type: "wireless-summary" }, { editing: true });
  assert.ok(screen.queryByRole("button", { name: /Expand/ }) === null);
  fireEvent.click(screen.getByTestId("body"));
  await settle();
  assert.ok(panel() === null);
});

test("on a surface that is not interactive, nothing expands", () => {
  mount({ type: "wireless-summary" }, { interactive: false });
  assert.ok(screen.queryByRole("button", { name: /Expand/ }) === null);
});

test("the wireless panel lists every channel with what an operator reads off it", async () => {
  mount({ type: "wireless-summary" });
  fireEvent.click(screen.getByRole("button", { name: "Expand Wireless" }));
  await settle();
  const p = within(panel() as HTMLElement);
  const rows = [...(panel() as HTMLElement).querySelectorAll("[data-row]")].map((r) => r.textContent);
  assert.equal(rows.length, 4, "every channel, not the lowest");
  assert.match(rows[0] ?? "", /Pastor.*3:40 left.*92%/);
  assert.match(rows[1] ?? "", /Handheld 3.*0:40 left.*19%/);
  assert.match(rows[2] ?? "", /Acoustic DI.*muted/);
  assert.match(rows[3] ?? "", /Spare lav.*offline/);
  assert.ok(p.getByRole("link", { name: "Open Mic slots" }));
});

test("Open <page> navigates", async () => {
  const router = mount({ type: "wireless-summary" });
  fireEvent.click(screen.getByRole("button", { name: "Expand Wireless" }));
  await settle();
  fireEvent.click(await eventually(() => screen.getByRole("link", { name: "Open Mic slots" })));
  await settle();
  await settle();
  assert.equal(router.state.location.pathname, "/mic-slots");
});

test("pressIsControls sees a control under the pointer and nothing else", () => {
  const tile = document.createElement("div");
  tile.innerHTML = `<p id="t">text</p><a id="a" href="#x"><span id="s">go</span></a><input id="i">`;
  document.body.append(tile);
  const at = (id: string) => tile.querySelector(`#${id}`);
  assert.equal(pressIsControls(at("t"), tile), false);
  assert.equal(pressIsControls(at("s"), tile), true, "inside a link");
  assert.equal(pressIsControls(at("i"), tile), true);
  tile.remove();
});
