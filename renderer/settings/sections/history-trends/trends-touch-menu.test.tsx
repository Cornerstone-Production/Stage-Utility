// The History chart's and the Trends tiles' menus open on a long press as well as a
// right-click. They used to listen for `contextmenu` only, which a touch never fires,
// so on an iPad a long press on a tile, the plot or a legend entry opened nothing.
//
// A real 500 ms hold: the trigger's timer is a real setTimeout and nothing here fakes it.
import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../../test-dom.js";

const teardown = installRenderDom();

// The chart refuses to map a pointer against a zero-width box (see trends-card.test.tsx).
Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { left: 0, top: 0, right: 640, bottom: 217, width: 640, height: 217, x: 0, y: 0, toJSON() {} };
  },
});

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TrendsCard } = await import("./trends-card.js");
const { TooltipProvider } = await import("../../../components/ui/index.js");
const { LONG_PRESS_MS } = await import("../../../components/ui/context-menu-trigger.js");
type TrendRecording = import("./trends.js").TrendRecording;

afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch { /* jsdom always has one */ }
});
after(() => {
  cleanup();
  teardown();
});

function recordings(): TrendRecording[] {
  const DAY = 24 * 60 * 60_000;
  const start = Date.parse("2026-01-04T15:00:00Z");
  return Array.from({ length: 10 }, (_, i) => ({
    serviceKey: `weekend:${i}`,
    serviceTypeId: "weekend",
    serviceTypeName: "weekend",
    serviceDate: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    t: start + i * 7 * DAY,
    seriesTitle: null,
    peakOccupancy: 100 + i,
    peakDb: 90,
    complete: true,
  }));
}

async function renderCard(recs: TrendRecording[]) {
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
    ok: true, status: 200, json: async () => [], text: async () => "[]",
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(React.createElement(TooltipProvider, null, React.createElement(TrendsCard, { recordings: recs, clock: null, loading: false })));
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

async function longPress(el: Element, pointerId = 1) {
  await act(async () => {
    fireEvent.pointerDown(el, { pointerId, pointerType: "touch", clientX: 30, clientY: 40 });
    await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 80));
  });
  await act(async () => {
    fireEvent.pointerUp(el, { pointerId, pointerType: "touch", clientX: 30, clientY: 40 });
  });
}

const menu = () => document.querySelector('[role="menu"]');

describe("the History and Trends menus open on a touch", () => {
  test("a long press on a Trends tile opens its menu", async () => {
    const view = await renderCard(recordings());
    await longPress(view.container.querySelector("[data-trend-tile]")!);
    assert.ok(menu(), "a long press on a tile opened no menu");
    view.unmount();
  });

  test("a long press on the plot opens the menu", async () => {
    const view = await renderCard(recordings());
    await longPress(view.container.querySelector("svg[data-domain-end]")!);
    assert.ok(menu(), "a long press on the plot opened no menu");
    view.unmount();
  });

  test("a long press on a legend entry opens the menu", async () => {
    const view = await renderCard(recordings());
    await longPress(view.container.querySelector("[data-series-toggle]")!);
    assert.ok(menu(), "a long press on a legend entry opened no menu");
    view.unmount();
  });

  test("a scrub across the plot does not", { timeout: 8000 }, async () => {
    const view = await renderCard(recordings());
    const plot = view.container.querySelector("svg[data-domain-end]")!;
    await act(async () => {
      fireEvent.pointerDown(plot, { pointerId: 1, pointerType: "touch", clientX: 30, clientY: 40 });
      fireEvent.pointerMove(plot, { pointerId: 1, pointerType: "touch", clientX: 90, clientY: 40 });
      await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 80));
    });
    const opened = menu() !== null;
    cleanup();
    assert.equal(opened, false, "a scrub opened the menu");
  });

  test("a long press on a legend entry does not also toggle it", async () => {
    const view = await renderCard(recordings());
    const entry = view.container.querySelector("[data-series-toggle]")!;
    const before = entry.getAttribute("aria-pressed");
    await longPress(entry);
    await act(async () => { fireEvent.click(entry); });
    assert.equal(entry.getAttribute("aria-pressed"), before, "the long press's trailing click toggled the series");
    view.unmount();
  });

  test("a right-click still opens it", async () => {
    const view = await renderCard(recordings());
    await act(async () => { fireEvent.contextMenu(view.container.querySelector("[data-trend-tile]")!); });
    assert.ok(menu(), "a right-click on a tile opened no menu");
    view.unmount();
  });

  test("a tap does not", async () => {
    const view = await renderCard(recordings());
    const tile = view.container.querySelector("[data-trend-tile]")!;
    await act(async () => {
      fireEvent.pointerDown(tile, { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 });
      fireEvent.pointerUp(tile, { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 });
      await new Promise((r) => setTimeout(r, LONG_PRESS_MS + 80));
    });
    assert.equal(menu(), null);
    view.unmount();
  });
});
