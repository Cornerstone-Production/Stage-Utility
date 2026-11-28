// servicecue-zone.test.tsx — which zone the ServiceCue pages print a time in.
//
// With no app time zone set the server reasons in its own clock's zone, so the
// page's plan list and its header clock both read that zone, and the page reads
// one zone throughout. The plan list prefers the rundown's own Planning Center
// zone when there is one. Driven through the real components with a stubbed
// fetch; the server's zone is picked a day apart from whatever zone runs this.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: node:assert inspects
// `actual` to build its message, and a live jsdom element does not finish.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, isPlumbing, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { serverZoneApartFromBrowser } from "../test-fixtures/zones.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ServiceCuePlan } = await import("./servicecue-plan-view.js");
const { ServiceCue } = await import("./servicecue-view.js");
const { planWhen } = await import("./servicecue-plan-choice.js");
const { clockParts } = await import("../lib/clock-format.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
let queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
afterEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  cleanup();
  resetStageState();
  resetReplayCache();
});

const SORT_DATE = "2026-09-13T14:00:00Z";
const PLAN = { serviceTypeId: "st1", serviceTypeName: "Weekend", planId: "p1", title: "Sunday", sortDate: SORT_DATE, dates: "September 13, 2026", isCurrent: true };

function stub(state: Record<string, unknown>, rundownZone: string | null) {
  const rundown = {
    serviceTypeId: "st1", planId: "p1", planTitle: "Sunday", planSeriesTitle: null, planDates: null,
    items: [], noteCategories: [], serviceTimes: [], timeZone: rundownZone, isActivePlan: true, isDefaultPlan: true,
  };
  return stubFetchWithLog((url) => {
    if (isPlumbing(url)) return ok({});
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) return ok([{ id: "svl1", name: "Audio", order: 0, columnRoles: [] }]);
    if (url.includes("/api/servicecue/roles")) return ok([]);
    if (url.includes("/api/servicecue/rundown")) return ok(rundown);
    if (url.includes("/api/plans/upcoming")) return ok({ plans: [PLAN], cacheAgeMs: 0 });
    if (url.includes("/api/pco/live")) return ok(null);
    if (url.includes("/api/state")) return ok({ pcoConfigured: true, serviceTypeId: "st1", planId: "p1", ...state });
    return ok({});
  });
}

async function mountPlanPage(): Promise<void> {
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TooltipProvider, null, React.createElement(ServiceCuePlan, { serviceTypeParam: "weekend", layoutParam: "audio" })),
    ),
  );
  for (let i = 0; i < 4; i++) await settle();
}

/** The plan button's words, for the plan in `zone`. */
function planButton(zone: string): string {
  const when = planWhen(SORT_DATE, zone);
  return `Sunday · ${when.date}, ${when.time}`;
}

/** The header clock's hours and minutes as drawn, and as `zone` reads now. */
const drawnClock = (): string => {
  const label = screen.getAllByText("Clock").find((el) => el.tagName === "SPAN");
  return label?.nextElementSibling?.textContent ?? "";
};
const clockIn = (zone: string): string => clockParts(Date.now(), { timeZone: zone }).head;

/** True when the drawn clock reads `zone`, allowing for a minute turning over
 *  between the reading taken before and the one taken after. */
async function clockReads(zone: string): Promise<void> {
  const before = clockIn(zone);
  await eventually(() => {
    const drawn = drawnClock();
    const ok = drawn.startsWith(before) || drawn.startsWith(clockIn(zone));
    assert.ok(ok, `the header clock read "${drawn}", not ${zone}'s "${clockIn(zone)}"`);
  });
}

test("the plan list reads the rundown's own Planning Center zone first", async () => {
  const host = serverZoneApartFromBrowser(SORT_DATE);
  const pco = host === "Pacific/Kiritimati" ? "Pacific/Pago_Pago" : "Pacific/Kiritimati";
  const f = stub({ timezone: null, hostTimezone: host }, pco);
  try {
    await mountPlanPage();
    await eventually(() => assert.equal(screen.getByRole("button", { name: "Choose a plan" }).textContent, planButton(pco)));
  } finally {
    f.restore();
  }
});

test("with no rundown zone and no app zone set, the plan list reads the server's clock", async () => {
  const host = serverZoneApartFromBrowser(SORT_DATE);
  const f = stub({ timezone: null, hostTimezone: host }, null);
  try {
    await mountPlanPage();
    await eventually(() =>
      assert.equal(screen.getByRole("button", { name: "Choose a plan" }).textContent, planButton(host), "the plan was dated by the browser's clock, not the server's"),
    );
  } finally {
    f.restore();
  }
});

test("the page's header clock reads the server's clock beside it", async () => {
  const host = serverZoneApartFromBrowser(Date.now());
  const f = stub({ timezone: null, hostTimezone: host }, null);
  try {
    await mountPlanPage();
    await clockReads(host);
  } finally {
    f.restore();
  }
});

test("the ServiceCue view's header clock reads the server's clock too", async () => {
  const host = serverZoneApartFromBrowser(Date.now());
  const f = stub({ timezone: null, hostTimezone: host }, null);
  try {
    render(React.createElement(TooltipProvider, null, React.createElement(ServiceCue, { serviceCueLayoutId: "svl1" })));
    for (let i = 0; i < 4; i++) await settle();
    await clockReads(host);
  } finally {
    f.restore();
  }
});
