// The ServiceCue page's plan switcher: ‹ plan ▾ › with a Following / Browsing
// badge, a paste field in its menu, and the choice kept in the address as
// `?plan=<id>`.
//
// Driven through the real ServiceCuePlan on a real TanStack router (a memory
// history), a stubbed fetch and a real QueryClient, so what is proved is a
// navigation resolving to a page, not a mock agreeing with itself. The fetch stub
// answers like the server does: no `planId` resolves to the plan the app follows
// (isDefaultPlan: true), a `planId` to that plan.
//
// The one thing the switcher must NEVER do is write the app's own plan. Every
// request the page makes is recorded, and "nothing wrote" is asserted as: no
// request that was not a GET, over a flow that steps, pastes and goes back.
//
// NOT asserted, because jsdom loads no stylesheet and does no layout: that the
// controls are vertically centred in the header, and what the menu looks like.
// Measured in a real browser instead (see the PR). NOTHING BELOW PASSES A DOM
// NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { alerts, ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, useParams } = await import("@tanstack/react-router");
const { ServiceCuePlan } = await import("./servicecue-plan-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const FUTURE = "2099-01-01T00:00:00Z";

/** The weekend type's plans, in the order the server sends them. 302 is the one
 *  the app follows. Youth has one plan, 901. */
const PLANS = [
  plan("st1", "Weekend", "301", "Early", "2026-10-04T14:00:00Z", false),
  plan("st1", "Weekend", "302", "Sunday", "2026-10-11T14:00:00Z", true),
  plan("st2", "Youth", "901", "Youth night", "2026-10-14T00:00:00Z", false),
  plan("st1", "Weekend", "303", "Special", "2026-10-18T14:00:00Z", false),
];

function plan(serviceTypeId: string, serviceTypeName: string, planId: string, title: string, sortDate: string, isCurrent: boolean) {
  return { serviceTypeId, serviceTypeName, planId, title, sortDate, dates: title, isCurrent };
}

function rundown(typeId: string, planId: string, title: string, isDefaultPlan: boolean, isActivePlan: boolean) {
  return {
    serviceTypeId: typeId,
    planId,
    planTitle: title,
    planSeriesTitle: null,
    planDates: null,
    items: [{ id: "i1", title: "Welcome", itemType: "item", lengthSec: 60, sequence: 0, notesByCategory: {}, description: null }],
    noteCategories: [],
    serviceTimes: [FUTURE],
    timeZone: "America/Chicago",
    isActivePlan,
    isDefaultPlan,
  };
}

interface Opts {
  pcoConfigured?: boolean;
  /** How the upcoming list answers. */
  upcoming?: () => unknown;
  /** The ids the rundown route knows for a type; any other planId comes back empty. */
  known?: string[];
  live?: unknown;
  /** Holds the rundown answer for a plan (null = the default) until the promise
   *  settles, so a test can have two reads in flight and settle them out of order. */
  hold?: (planId: string | null) => Promise<void> | undefined;
}

/** A fetch that answers like the server, and records every request. */
function stubServer(o: Opts = {}) {
  const calls: { method: string; url: string }[] = [];
  const known = o.known ?? ["301", "302", "303"];
  const f = stubFetchWithLog((url, init) => {
    calls.push({ method: init?.method ?? "GET", url });
    if (url.includes("/api/state")) return ok({ serviceTypeId: "st1", planId: "302", pcoConfigured: o.pcoConfigured ?? true, hourCycle: "12h" });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }, { id: "st2", name: "Youth" }]);
    if (url.includes("/api/servicecue/layouts")) return ok([{ id: "svl1", name: "Audio", order: 0, columnRoles: [] }]);
    if (url.includes("/api/servicecue/roles")) return ok([]);
    if (url.includes("/api/plans/upcoming")) return o.upcoming ? o.upcoming() : ok({ plans: PLANS, cacheAgeMs: 0 });
    if (url.includes("/api/pco/live")) return ok(o.live ?? null);
    if (url.includes("/api/servicecue/rundown")) {
      const q = new URL(url, "http://x").searchParams;
      const id = q.get("planId");
      const held = o.hold?.(id);
      const answer = rundownAnswer(q);
      return held ? held.then(() => answer) : answer;
    }
    return ok({});
  });
  return { ...f, calls };

  function rundownAnswer(q: URLSearchParams) {
    const typeId = q.get("serviceTypeId") ?? "";
    const id = q.get("planId");
    if (typeId === "st2") return ok(rundown("st2", "901", "Youth night", !id, false));
    if (!id) return ok(rundown("st1", "302", "Sunday", true, true));
    if (!known.includes(id)) return ok({ ...rundown("st1", "", "", false, false), planId: null, items: [], serviceTimes: [] });
    return ok(rundown("st1", id, PLANS.find((p) => p.planId === id)?.title ?? id, id === "302", id === "302"));
  }
}

/** The real route shape: /servicecue/$serviceType/$layout, mounted at `url`. */
function PageRoute() {
  const p = useParams({ strict: false }) as { serviceType?: string; layout?: string };
  return React.createElement(ServiceCuePlan, { serviceTypeParam: p.serviceType ?? "", layoutParam: p.layout ?? "" });
}

async function mountAt(url: string) {
  const rootRoute = createRootRoute({});
  const route = createRoute({ getParentRoute: () => rootRoute, path: "/servicecue/$serviceType/$layout", component: PageRoute });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history: createMemoryHistory({ initialEntries: [url] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router } as never)),
    ),
  );
  for (let i = 0; i < 6; i++) await settle();
  return router;
}

const page = () => document.body.textContent ?? "";
const badge = () => document.querySelector("[data-plan-badge]")?.getAttribute("data-plan-badge") ?? null;
const button = (label: string) => screen.queryByLabelText(label) as HTMLButtonElement | null;
const hasText = (t: string) => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === t);
const planParam = (router: { state: { location: { search: Record<string, unknown> } } }) => router.state.location.search.plan;
/** Every request that was not a read. The event stream's own subscription POST is
 *  not one that writes anything the operator owns (it registers which channels
 *  this page listens to, and fires whenever the page subscribes), so it is not
 *  counted: left in, this guard flaked whenever the subscription landed mid-test. */
const writes = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method !== "GET" && !c.url.includes("/api/events/subscribe"));

async function click(el: HTMLElement | null): Promise<void> {
  assert.ok(el, "the control never rendered");
  await act(async () => void fireEvent.click(el!));
  for (let i = 0; i < 6; i++) await settle();
}

test("on the plan the app follows it says Following, with no way back to live", async () => {
  const f = stubServer();
  try {
    await mountAt("/servicecue/weekend/audio");
    assert.equal(badge(), "following");
    assert.equal(hasText("Back to live"), false);
    assert.ok(page().includes("Sunday"), "the followed plan's own title is on the page");
    assert.equal(
      f.calls.some((c) => c.url.includes("/api/servicecue/rundown") && c.url.includes("planId")),
      false,
      "following asks the server for the default and names no plan",
    );
  } finally {
    f.restore();
  }
});

test("an arrow moves the page to the next plan, in the address, and it reads Browsing with Back to live", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio");
    await click(button("Next plan"));
    assert.equal(String(planParam(router)), "303");
    assert.ok(router.state.location.href.includes("plan=303"), router.state.location.href);
    assert.ok(!router.state.location.href.includes("%22"), "an id is not quoted in the address");
    assert.equal(badge(), "browsing");
    assert.equal(hasText("Back to live"), true);
    assert.ok(f.calls.some((c) => c.url.includes("/api/servicecue/rundown") && c.url.includes("planId=303")), "the rundown was asked for that plan");
    assert.ok(page().includes("Special"), "and that plan is what is drawn");
  } finally {
    f.restore();
  }
});

test("Back to live drops the param and reads Following again", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio?plan=303");
    assert.equal(badge(), "browsing");
    await click([...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Back to live") ?? null);
    assert.equal(planParam(router), undefined);
    assert.equal(badge(), "following");
  } finally {
    f.restore();
  }
});

test("stepping onto the followed plan reads Following, from the server's own word", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio?plan=303");
    await click(button("Previous plan"));
    assert.equal(String(planParam(router)), "302");
    assert.equal(badge(), "following", "plan 302 is the app's plan, so it is the followed one even with a param");
  } finally {
    f.restore();
  }
});

test("a refresh stays put: ?plan= on load shows that plan, browsing", async () => {
  const f = stubServer();
  try {
    await mountAt("/servicecue/weekend/audio?plan=301");
    assert.equal(badge(), "browsing");
    assert.ok(page().includes("Early"));
  } finally {
    f.restore();
  }
});

test("the arrows stop at the first and last plan instead of wrapping", async () => {
  const f = stubServer();
  try {
    await mountAt("/servicecue/weekend/audio?plan=301");
    assert.equal(button("Previous plan")?.disabled, true);
    assert.equal(button("Next plan")?.disabled, false);
    cleanup();
    await mountAt("/servicecue/weekend/audio?plan=303");
    assert.equal(button("Next plan")?.disabled, true);
    assert.equal(button("Previous plan")?.disabled, false);
  } finally {
    f.restore();
  }
});

test("it walks this service type's plans only, never another type's", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio?plan=303");
    // 901 (Youth) sits between 302 and 303 by date in the shared list; stepping
    // back must skip it.
    await click(button("Previous plan"));
    assert.equal(String(planParam(router)), "302");
  } finally {
    f.restore();
  }
});

test("nothing it does writes the app's plan: no request but GETs, through step, paste and back", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio");
    await click(button("Next plan"));
    await click(button("Previous plan"));
    await click(button("Choose a plan"));
    const field = screen.getByLabelText("Paste a Planning Center plan link");
    await act(async () => void fireEvent.change(field, { target: { value: "https://services.planningcenteronline.com/plans/301" } }));
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(String(planParam(router)), "301");
    await click([...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Back to live") ?? null);
    assert.equal(planParam(router), undefined);
    assert.deepEqual(writes(f.calls), [], "a write went out");
    assert.equal(f.calls.some((c) => /\/api\/(plan|service-type)(\/|$|\?)/.test(c.url) && c.method !== "GET"), false);
  } finally {
    f.restore();
  }
});

test("a browsed plan counts down to its own start and shows no Live, Remaining or Over", async () => {
  const live = { mode: "item", currentItemId: "i1", label: "Welcome", lengthSec: 600, liveStartAt: new Date().toISOString(), targetAt: null, serverNow: new Date().toISOString(), currentItemTitle: "Welcome", nextItemTitle: null, serviceTimeId: null, serviceTimeStartsAt: null };
  const f = stubServer({ live });
  try {
    await mountAt("/servicecue/weekend/audio");
    assert.ok(page().includes("Remaining"), "the followed plan carries the live timer");
    assert.ok(page().includes("Live"));
    cleanup();
    await mountAt("/servicecue/weekend/audio?plan=303");
    assert.ok(page().includes("Starts in"), "a browsed plan shows its own countdown");
    assert.equal(page().includes("Remaining"), false);
    assert.equal(page().includes("Over"), false);
    assert.equal(page().includes("Live"), false);
  } finally {
    f.restore();
  }
});

test("pasting a link to a plan of this type browses to it", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio");
    await click(button("Choose a plan"));
    const field = screen.getByLabelText("Paste a Planning Center plan link");
    await act(async () => void fireEvent.change(field, { target: { value: "https://services.planningcenteronline.com/plans/303/live" } }));
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(String(planParam(router)), "303");
    assert.equal(router.state.location.pathname, "/servicecue/weekend/audio");
  } finally {
    f.restore();
  }
});

test("pasting a link to another service type's plan opens that type's page on it", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio");
    await click(button("Choose a plan"));
    const field = screen.getByLabelText("Paste a Planning Center plan link");
    await act(async () => void fireEvent.change(field, { target: { value: "https://services.planningcenteronline.com/plans/901" } }));
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(router.state.location.pathname, "/servicecue/youth/audio");
    assert.equal(String(planParam(router)), "901");
    assert.ok(page().includes("Youth night"));
  } finally {
    f.restore();
  }
});

test("text that is not a plan link says so in the menu and goes nowhere", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/audio");
    await click(button("Choose a plan"));
    const field = screen.getByLabelText("Paste a Planning Center plan link");
    await act(async () => void fireEvent.change(field, { target: { value: "hello" } }));
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }));
    assert.match(alerts(), /doesn't look like a Planning Center plan link/i);
    assert.equal(planParam(router), undefined);
  } finally {
    f.restore();
  }
});

test("a link whose plan this type does not have says so on the page, and reaches the log", async () => {
  const f = stubServer();
  try {
    await mountAt("/servicecue/weekend/audio?plan=777");
    assert.match(alerts(), /isn't one of this service type's plans/i);
    assert.ok(f.logs.some((l) => l.tag === "servicecue" && /plan 777/.test(l.message)), `expected a [servicecue] line, got ${JSON.stringify(f.logs)}`);
    assert.equal(badge(), "browsing", "an unresolved plan is not the followed one");
    assert.equal(hasText("Back to live"), true, "and the way out is there");
  } finally {
    f.restore();
  }
});

test("the menu lists this type's plans, the current one selected", async () => {
  const f = stubServer();
  try {
    await mountAt("/servicecue/weekend/audio?plan=303");
    await click(button("Choose a plan"));
    const options = [...document.querySelectorAll('[role="option"]')];
    assert.deepEqual(
      options.map((o) => o.querySelector(".truncate")?.textContent ?? ""),
      ["Early", "Sunday", "Special"],
      "three weekend plans, none of Youth's",
    );
    assert.equal(options.filter((o) => o.getAttribute("aria-selected") === "true").length, 1);
    assert.equal(options.find((o) => o.getAttribute("aria-selected") === "true")?.textContent?.startsWith("Special"), true);
    assert.equal(options.some((o) => (o.textContent ?? "").includes("Following") && (o.textContent ?? "").startsWith("Sunday")), true, "the followed plan is marked");
    assert.match(options.map((o) => o.textContent ?? "").join(" "), /\d{1,2}:\d{2}/, "each carries its time");
  } finally {
    f.restore();
  }
});

test("a failed plan list says so, logs it, and leaves the arrows off", async () => {
  const f = stubServer({ upcoming: () => { throw new TypeError("fetch failed"); } });
  try {
    await mountAt("/servicecue/weekend/audio");
    assert.match(alerts(), /Couldn't load the plan list/i);
    assert.ok(f.logs.some((l) => l.tag === "servicecue" && /plan list/.test(l.message)), JSON.stringify(f.logs));
    assert.equal(button("Next plan")?.disabled, true);
    assert.equal(button("Previous plan")?.disabled, true);
    assert.ok(page().includes("Sunday"), "the page itself still follows its plan");
  } finally {
    f.restore();
  }
});

test("a plan list Planning Center could not refresh is reported the same way", async () => {
  const f = stubServer({ upcoming: () => ok({ plans: [], cacheAgeMs: 0, unavailable: "Planning Center answered 503" }) });
  try {
    await mountAt("/servicecue/weekend/audio");
    assert.match(alerts(), /Couldn't load the plan list/i);
    assert.ok(f.logs.some((l) => l.tag === "servicecue" && /503/.test(l.message)), JSON.stringify(f.logs));
  } finally {
    f.restore();
  }
});

test("an empty list is not an error: disabled arrows and a plain line in the menu", async () => {
  const f = stubServer({ upcoming: () => ok({ plans: [], cacheAgeMs: 0 }) });
  try {
    await mountAt("/servicecue/weekend/audio");
    assert.equal(alerts(), "");
    assert.equal(button("Next plan")?.disabled, true);
    await click(button("Choose a plan"));
    assert.ok(page().includes("No plans for this service type"));
    assert.ok(screen.getByLabelText("Paste a Planning Center plan link"), "pasting still works with no list");
  } finally {
    f.restore();
  }
});

test("with Planning Center not connected there is no switcher and no plan list asked for", async () => {
  const f = stubServer({ pcoConfigured: false });
  try {
    await mountAt("/servicecue/weekend/audio");
    assert.equal(button("Next plan"), null);
    assert.equal(f.calls.some((c) => c.url.includes("/api/plans/upcoming")), false);
    assert.equal(alerts(), "", "not connected is a state, not a failure");
  } finally {
    f.restore();
  }
});

test("a rundown read that fails is still an error, not a browse", async () => {
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ pcoConfigured: true });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts") || url.includes("/api/servicecue/roles")) return ok([]);
    if (url.includes("/api/plans/upcoming")) return ok({ plans: PLANS, cacheAgeMs: 0 });
    if (url.includes("/api/servicecue/rundown")) return reply(500, { error: "boom" });
    return ok(null);
  });
  try {
    await mountAt("/servicecue/weekend/audio?plan=303");
    assert.ok(f.logs.some((l) => l.tag === "servicecue" && /rundown/.test(l.message)));
    assert.equal(page().includes("isn't one of this service type's plans"), false, "a failure is not reported as a missing plan");
  } finally {
    f.restore();
  }
});

/** A promise and the function that settles it. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

test("a layout change keeps the plan being browsed, and the text size, in the address", async () => {
  const f = stubServer();
  try {
    const router = await mountAt("/servicecue/weekend/all-columns?plan=303&text=150");
    const select = screen.getByLabelText("Layout") as HTMLSelectElement;
    await act(async () => void fireEvent.change(select, { target: { value: "svl1" } }));
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(router.state.location.pathname, "/servicecue/weekend/audio");
    assert.equal(String(planParam(router)), "303", "still browsing 303");
    assert.equal(String((router.state.location.search as Record<string, unknown>).text), "150");
    assert.equal(badge(), "browsing");
  } finally {
    f.restore();
  }
});

test("the arrows wait for the page's own plan: forward before it has loaded does not jump to the first plan", async () => {
  const gate = deferred();
  const f = stubServer({ hold: () => gate.promise });
  try {
    const router = await mountAt("/servicecue/weekend/audio");
    assert.equal(button("Next plan")?.disabled, true);
    assert.equal(button("Previous plan")?.disabled, true);
    gate.release();
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(button("Next plan")?.disabled, false);
    assert.equal(planParam(router), undefined, "nothing was navigated while it loaded");
  } finally {
    f.restore();
  }
});

test("stepping on drops the previous plan from the screen at once, rather than drawing it under the new one's name", async () => {
  const gate = deferred();
  const f = stubServer({ hold: (id) => (id === "303" ? gate.promise : undefined) });
  try {
    await mountAt("/servicecue/weekend/audio");
    assert.ok(page().includes("Sunday"));
    await click(button("Next plan"));
    assert.equal(page().includes("Sunday"), false, "303 has not answered, and 302 must not still be on screen");
    gate.release();
    for (let i = 0; i < 6; i++) await settle();
    assert.ok(page().includes("Special"));
  } finally {
    f.restore();
  }
});

test("a slow answer for the plan stepped away from does not overwrite the one stepped to", async () => {
  const slow303 = deferred();
  const f = stubServer({ hold: (id) => (id === "303" ? slow303.promise : undefined) });
  try {
    const router = await mountAt("/servicecue/weekend/audio?plan=303");
    await click(button("Previous plan"));
    assert.equal(String(planParam(router)), "302");
    assert.ok(page().includes("Sunday"), "302 answered");
    slow303.release();
    for (let i = 0; i < 6; i++) await settle();
    assert.ok(page().includes("Sunday"), "302 is still what is on screen");
    assert.equal(page().includes("Special"), false, "303's late answer was dropped");
  } finally {
    f.restore();
  }
});
