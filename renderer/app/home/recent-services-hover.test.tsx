// Home's copy of the tooltip-through-the-menu bug — the call site the History
// fix (6e580c2f) did not reach.
//
// History's own trend chart stops tracking the pointer while its right-click
// menu is open (see overview-blend.test.tsx). Home's Recent services widget
// draws the SAME chart under the SAME kind of menu — card-toggles.ts puts
// "SPL trend line" on this card's own context menu — but nothing threaded the
// signal down: `RecentServicesCard` never passed `hoverSuppressed` to the
// chart at all.
//
// The fix reaches the chart through five hops: HomeGrid knows which card's
// menu is open (home-route.tsx's `menu.cardId`), passes it into the render
// context as `activeCardMenuId`, and ObjectContent/HomeCard/RecentServicesCard
// carry it the rest of the way. Testing the chart's own `hoverSuppressed` prop
// again (attendance-trend-chart.test.tsx already does that) would prove
// nothing about whether anything upstream actually sets it — this renders
// through ObjectContent, the one dispatcher both Home and the editor call, so
// a broken hop anywhere in that chain shows up here.
//
// What this cannot see: jsdom lays out nothing, so "the tooltip is drawn
// through the menu" itself is not something a DOM test can observe — only
// that the chart's hover state does or does not activate. attendance-trend-
// chart.test.tsx already proved that "suppressed" means "no tooltip drawn at
// all", so this stays at the level it can actually check: whether the right
// boolean reaches the chart for the right card.

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** Three weekends so the chart actually draws — it renders nothing below two
 *  points, and a null render cannot be hovered at all. */
const WEEKENDS = ["2026-08-16", "2026-08-23", "2026-08-30"];
const ATTENDANCE: ServiceAttendance[] = WEEKENDS.map((day, i) => ({
  serviceKey: `st-1:plan-${day}:${day}`,
  serviceTypeId: "st-1",
  serviceTypeName: "Weekend",
  planId: `plan-${day}`,
  planTitle: "Sample plan",
  seriesTitle: null,
  serviceDate: day,
  serviceTimeId: null,
  serviceTimeStartsAt: `${day}T15:00:00.000Z`,
  startedAt: `${day}T15:00:00.000Z`,
  endedAt: `${day}T16:30:00.000Z`,
  samples: [],
  attendanceBaseline: 0,
  totalAttendance: 200 + i * 10,
  peakAttendance: 200 + i * 10,
  peakOccupancy: 200 + i * 10,
  minOccupancy: 0,
  lastAttendance: 200 + i * 10,
  lastOccupancy: 200 + i * 10,
}));

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const body = url.includes("/api/attendance/history") ? ATTENDANCE : [];
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ObjectContent } = await import("../../main/layout-renderer.js");
const { makeRenderCtx } = await import("../../main/test-render-ctx.js");
// A router in context: this card renders "Open History" as a real <Link>,
// which asks the router to build its location and throws with none present.
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } =
  await import("@tanstack/react-router");

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
await router.load();

const settle = () => new Promise((r) => setTimeout(r, 0));

before(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => {
  await settle();
  teardown();
});

/** The chart's hover tooltip — its only z-10 overlay. */
const tooltip = (c: HTMLElement) => c.querySelector<HTMLElement>("div.z-10");
/** The trend chart's own SVG, by its `role="img"` — a bare `"svg"` selector
 *  finds the Lucide arrow icon in the Attendance headline stat first, which
 *  has no pointer handler at all and made every hover in this file a no-op
 *  before this was narrowed. */
const chartSvg = (c: HTMLElement) => c.querySelector<SVGSVGElement>('svg[role="img"]');

async function renderCard(activeCardMenuId: string | null): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      React.createElement(
        RouterContextProvider as never,
        { router },
        React.createElement(ObjectContent, {
          o: { id: "o1", x: 0, y: 0, w: 6, h: 4, z: 1, config: { type: "home-recent-services" }, style: {} },
          ctx: makeRenderCtx({ home: true, interactive: true, activeCardMenuId }),
        } as never),
      ),
    ));
    await settle();
  });
  return container;
}

describe("Recent services' chart, under its own right-click menu", () => {
  test("suppresses its hover while THIS card's menu is open", async (t) => {
    const container = await renderCard("o1");
    t.after(() => cleanup());
    const svg = chartSvg(container);
    assert.ok(svg, "no chart rendered at all — the fixture gave it fewer than two weekends");
    fireEvent.pointerMove(svg!, { clientX: 400, clientY: 40 });
    assert.ok(!tooltip(container), "the chart is still tracking the pointer under this card's own open menu");
  });

  test("keeps hovering normally while a DIFFERENT card's menu is open", async (t) => {
    const container = await renderCard("some-other-card");
    t.after(() => cleanup());
    const svg = chartSvg(container)!;
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 40 });
    assert.ok(tooltip(container), "this card suppressed its hover for a menu that belongs to a different card");
  });

  test("keeps hovering normally with no menu open", async (t) => {
    const container = await renderCard(null);
    t.after(() => cleanup());
    const svg = chartSvg(container)!;
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 40 });
    assert.ok(tooltip(container), "the chart suppressed its hover with no menu open at all");
  });
});
