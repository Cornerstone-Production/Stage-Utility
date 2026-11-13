// /stageplots following the live or next plan, through the real page, the real
// resolver and the real plan-following hook, over a stubbed server: the stage
// state the /patch tests use (GET /api/state, then stage:state-changed), and
// GET /api/plans/upcoming with or without `unavailable`.
//
// Each fixture is built so the wrong branch shows something different: the
// live plan always has an override to a plot that is not the default, and the
// venue that should read "Default" has an override for another plan.
//
// What is NOT here, because jsdom loads no stylesheet: the badge's accent tint
// and dot, the notice's warning colour and shadow, and the 390 px phone layout
// of mockup section 3. Those are driven in a browser.
//
// No DOM node is ever an assert operand: node:assert inspects `actual` to
// build its message, and inspecting a jsdom element does not finish, so a
// failing check would hang the file instead of saying what failed.
//
// Every name below is invented. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { StagePlotsView } from "@main/types/stageplots";
import type { UpcomingPlansDTO } from "@main/types/pco";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let DOC: StagePlotsView;
let STATE: StageState;
let UPCOMING: UpcomingPlansDTO;
/** Every path the page asked for. */
let asked: string[] = [];
/** When set, GET /api/state waits for this before it answers. */
let stateGate: Promise<void> | null = null;
/** When set, GET /api/plans/upcoming waits for this before it answers. */
let listGate: Promise<void> | null = null;
/** When true, GET /api/plans/upcoming fails (the read itself, not `unavailable`). */
let listFails = false;
/** Every [stageplots] line the page posted to /api/log/client. */
let logged: string[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const path = String(url).split("?")[0];
  asked.push(path);
  if (path === "/api/log/client") {
    const b = JSON.parse(String(init?.body)) as { tag: string; message: string };
    if (b.tag === "stageplots") logged.push(b.message);
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "{}" };
  }
  if (path === "/api/state" && stateGate) await stateGate;
  if (path === "/api/plans/upcoming") {
    if (listGate) await listGate;
    if (listFails) return { ok: false, status: 502, statusText: "Bad Gateway", json: async () => ({ error: "bad gateway" }), text: async () => '{"error":"bad gateway"}' };
  }
  const body = path === "/api/stageplots" ? DOC : path === "/api/state" ? STATE : path === "/api/plans/upcoming" ? UPCOMING : null;
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, screen, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { StagePlotsPage, LAST_VENUE_KEY } = await import("./stageplots-view.js");
const { DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

const plot = (id: string, venueId: string, name: string) => ({ id, venueId, name, backgroundId: null, bgFade: 0.4, items: [], version: 0 });

function doc(): StagePlotsView {
  return {
    venues: [
      { id: "v-main", name: "Room One", kind: "home", notes: "", plotIds: ["p-std", "p-bap", "p-xmas"], defaultPlotId: "p-std" },
      { id: "v-off", name: "Hall Away", kind: "offsite", notes: "", plotIds: ["p-hall", "p-hall-alt"], defaultPlotId: "p-hall" },
    ],
    backgrounds: [],
    plots: [
      plot("p-std", "v-main", "Standard"),
      plot("p-bap", "v-main", "Baptism"),
      plot("p-xmas", "v-main", "Christmas"),
      plot("p-hall", "v-off", "Setup"),
      plot("p-hall-alt", "v-off", "Setup alt"),
    ],
    overrides: [
      { planId: "plan-9", venueId: "v-main", plotId: "p-bap", planDate: "2026-11-15T15:00:00.000Z" },
      { planId: "plan-9", venueId: "v-off", plotId: "p-hall-alt", planDate: "2026-11-15T15:00:00.000Z" },
      { planId: "plan-11", venueId: "v-main", plotId: "p-xmas", planDate: null },
      { planId: "plan-other", venueId: "v-off", plotId: "p-hall-alt", planDate: null },
    ],
  };
}

const upcomingPlan = (planId: string, sortDate: string) => ({
  serviceTypeId: "st-1",
  serviceTypeName: "Service One",
  planId,
  title: "Week",
  sortDate,
  dates: null,
  isCurrent: false,
});

let client: InstanceType<typeof QueryClient>;

async function mount(venueId: string | null = "v-main") {
  if (venueId) localStorage.setItem(LAST_VENUE_KEY, venueId);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    render(React.createElement(QueryClientProvider, { client }, React.createElement(StagePlotsPage)));
  });
  for (let i = 0; i < 4; i++) await settle();
}

/** Ask for the upcoming plans again, as the page's one-minute timer does. */
async function readAgain() {
  await act(async () => {
    await client.refetchQueries();
  });
  await settle();
  await settle();
}

async function pushState(next: Partial<StageState>) {
  STATE = { ...STATE, ...next };
  await act(async () => {
    FakeEventSource.last?.push("stage:state-changed", STATE);
  });
  await settle();
}

const badge = () => screen.queryByTestId("plan-badge")?.textContent ?? null;
const selectedTab = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent ?? null;
const notice = () => screen.queryByRole("status")?.textContent ?? null;

beforeEach(() => {
  DOC = doc();
  STATE = {
    ...DEFAULT_STAGE_STATE,
    pcoConfigured: true,
    serviceTypeId: "st-1",
    serviceTypeName: "Service One",
    planId: "plan-9",
    planTitle: "Week",
    planDates: "November 15, 2026",
    timezone: "America/Chicago",
  };
  UPCOMING = { plans: [upcomingPlan("plan-9", "2026-11-15T15:00:00Z"), upcomingPlan("plan-11", "2026-11-15T17:00:00Z")], cacheAgeMs: 0 };
  asked = [];
  stateGate = null;
  listGate = null;
  listFails = false;
  logged = [];
  localStorage.clear();
});
afterEach(async () => {
  cleanup();
  await settle();
  resetStageState();
  resetReplayCache();
});
after(() => unmountAndTeardown(cleanup, teardown));

describe("/stageplots follows the live or next plan", () => {
  test("with an override for the live plan the badge reads For this plan with its date and that tab is selected", async () => {
    await mount();
    assert.equal(badge(), "For this plan · Sun 15 Nov");
    assert.equal(selectedTab(), "Baptism");
    // The other plots still open by tab.
    fireEvent.click(screen.getByRole("tab", { name: /Christmas/ }));
    assert.equal(selectedTab(), "Christmas");
    assert.equal(badge(), null, "a plot nobody chose for this plan was badged");
  });

  test("a slow stage state draws no plot until the plan is known: never the default, then this plan's", async () => {
    let open!: () => void;
    stateGate = new Promise((resolve) => (open = resolve));
    await mount();
    assert.equal(screen.queryByRole("tab") === null, true, "a plot was drawn before the plan was known");
    assert.ok(screen.getByText("Loading…"));
    await act(async () => open());
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(selectedTab(), "Baptism");
  });

  test("a slow plan list holds the first draw about 2 s at most, then draws this plan's plot", async () => {
    let open!: () => void;
    listGate = new Promise((resolve) => (open = resolve));
    await mount();
    try {
      assert.equal(screen.queryByRole("tab") === null, true);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 2300));
      });
      await settle();
      assert.ok(screen.queryAllByRole("tab").length > 0, "a slow plan list kept the page on Loading");
      assert.equal(selectedTab(), "Baptism");
      assert.equal(notice(), null);
    } finally {
      await act(async () => open());
      await settle();
    }
    assert.equal(selectedTab(), "Baptism");
  });

  test("a hung read after a good one never blanks the plot; failed reads count as unavailable", async () => {
    await mount();
    assert.equal(selectedTab(), "Baptism");
    let fail!: () => void;
    listGate = new Promise((resolve) => (fail = resolve));
    listFails = true;
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = client.refetchQueries();
    });
    await settle();
    assert.equal(selectedTab(), "Baptism", "a read in flight blanked the plot");
    assert.equal(screen.queryByText("Loading…") === null, true);
    await act(async () => {
      fail();
      await pending.catch(() => {});
    });
    await settle();
    assert.equal(selectedTab(), "Baptism", "one failed read swapped the plot");
    assert.equal(notice(), null);
    listGate = null;
    await readAgain();
    assert.equal(notice(), "Planning Center is unreachable, showing the default plot.", "two failed reads in a row were not believed");
    assert.equal(selectedTab(), "StandardDefault");
  });

  test("a plan list that fails on first load draws at once, with the notice, and a hung read after it never blanks the page", async () => {
    listFails = true;
    await mount();
    assert.equal(notice(), "Planning Center is unreachable, showing the default plot.");
    assert.equal(selectedTab(), "StandardDefault");
    // react-query clears a query's error when it asks again: the page must not
    // read that as "not known yet".
    let release!: () => void;
    listGate = new Promise((resolve) => (release = resolve));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = client.refetchQueries();
    });
    try {
      await settle();
      assert.equal(screen.queryByText("Loading…") === null, true, "a hung read after a failed one blanked the page");
      assert.equal(selectedTab(), "StandardDefault");
    } finally {
      await act(async () => {
        release();
        await pending.catch(() => {});
      });
    }
  });

  test("once drawn, the page never goes back to Loading: Planning Center connecting with the plan list still on its way", async () => {
    // Drawn while not connected (no list to wait for), then the credentials are
    // saved and the stage state says connected: the list's first read is now
    // outstanding, which before the first draw would hold the page.
    STATE = { ...STATE, pcoConfigured: false };
    await mount();
    assert.equal(selectedTab(), "StandardDefault");
    let release!: () => void;
    listGate = new Promise((resolve) => (release = resolve));
    try {
      await pushState({ pcoConfigured: true });
      await settle();
      assert.equal(screen.queryByText("Loading…") === null, true, "the page went back to Loading after it had drawn");
      assert.ok(screen.queryAllByRole("tab").length > 0);
    } finally {
      await act(async () => release());
      await settle();
      await settle();
    }
    assert.equal(selectedTab(), "Baptism");
  });

  test("an evening plan's date is the app's day: Sunday evening in Chicago is not Monday", async () => {
    // 01:00 UTC on Monday 16 Nov is Sunday 15 Nov, 7 pm, in Chicago.
    UPCOMING = { ...UPCOMING, plans: [upcomingPlan("plan-9", "2026-11-16T01:00:00Z")] };
    DOC.overrides[0].planDate = null;
    await mount();
    assert.equal(badge(), "For this plan · Sun 15 Nov");
  });

  test("with no zone set, the plan's date follows the server's clock, not the browser's", async () => {
    // 11:00 UTC on Sunday 15 Nov is already Monday 16 Nov in UTC+14, and still
    // Sunday from UTC-11 to UTC+12, where any browser running this test sits.
    UPCOMING = { ...UPCOMING, plans: [upcomingPlan("plan-9", "2026-11-15T11:00:00Z")] };
    DOC.overrides[0].planDate = null;
    STATE = { ...STATE, timezone: null, hostTimezone: "Pacific/Kiritimati" };
    await mount();
    assert.equal(badge(), "For this plan · Mon 16 Nov");
  });

  test("with no plan to follow there is no unreachable notice", async () => {
    STATE = { ...STATE, planId: null, planDates: null };
    UPCOMING = { ...UPCOMING, unavailable: "Planning Center returned 503" };
    await mount();
    assert.equal(notice(), null);
    assert.equal(badge(), "Default");
  });

  test("going unreachable and coming back are each said once on [stageplots]", async () => {
    await mount();
    UPCOMING = { ...UPCOMING, unavailable: "Planning Center returned 503" };
    await readAgain();
    await readAgain();
    await readAgain();
    UPCOMING = { plans: UPCOMING.plans, cacheAgeMs: 0 };
    await readAgain();
    await readAgain();
    assert.deepEqual(
      logged.map((l) => l.replace(/\(.*\)/, "(…)")),
      [
        "Planning Center is unreachable (…); /stageplots shows each venue's default plot",
        "Planning Center can be read again; /stageplots follows the live or next plan",
      ],
    );
  });

  test("the venue list says which plot each venue shows", async () => {
    await mount(null);
    fireEvent.click(screen.getByRole("button", { name: /Stage plots/ }));
    await settle();
    const lines = within(screen.getByTestId("venue-list"))
      .getAllByRole("button")
      .map((b) => b.querySelector("small")?.textContent);
    assert.deepEqual(lines, ["3 plots · Baptism for this plan · no background", "2 plots · Setup alt for this plan · no background"]);
  });

  test("with no override it reads Default", async () => {
    // plan-other has an override, for the other venue: a resolver that ignored
    // the venue would show it here.
    STATE = { ...STATE, planId: "plan-other" };
    await mount();
    assert.equal(badge(), "Default");
    assert.equal(selectedTab(), "StandardDefault");
  });

  test("two plans on one day each show their own while live", async () => {
    await mount();
    assert.equal(selectedTab(), "Baptism");
    await pushState({ planId: "plan-11" });
    assert.equal(selectedTab(), "Christmas");
    // plan-11's date comes from the upcoming list, the override having none.
    assert.equal(badge(), "For this plan · Sun 15 Nov");
  });

  test("a stage-state change to the next plan redraws without a reload, over a tab picked by hand", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: /Standard/ }));
    assert.equal(selectedTab(), "StandardDefault");
    await pushState({ planId: "plan-11" });
    assert.equal(selectedTab(), "Christmas", "an old pick hid the new plan's plot");
    assert.equal(asked.filter((p) => p === "/api/stageplots").length, 1, "the page read the plots again to follow the plan");
  });

  test("PCO unreachable shows the notice and the default", async () => {
    UPCOMING = { ...UPCOMING, unavailable: "Planning Center returned 503" };
    await mount();
    assert.equal(notice(), "Planning Center is unreachable, showing the default plot.");
    assert.equal(badge(), "Default");
    assert.equal(selectedTab(), "StandardDefault", "the live plan's override showed while Planning Center could not be read");
  });

  test("one failed read after a good one does not flicker the plot; a second does, and a good one brings it back", async () => {
    await mount();
    assert.equal(selectedTab(), "Baptism");
    UPCOMING = { ...UPCOMING, unavailable: "Planning Center returned 503" };
    await readAgain();
    assert.equal(notice(), null, "one failed poll put up the notice");
    assert.equal(selectedTab(), "Baptism", "one failed poll swapped the plot");
    await readAgain();
    assert.equal(notice(), "Planning Center is unreachable, showing the default plot.");
    assert.equal(selectedTab(), "StandardDefault");
    UPCOMING = { plans: UPCOMING.plans, cacheAgeMs: 0 };
    await readAgain();
    assert.equal(notice(), null);
    assert.equal(selectedTab(), "Baptism");
  });

  test("an offsite venue with no plan shows its default and no plan badge", async () => {
    // Hall Away has overrides; with no plan, none of them applies.
    STATE = { ...STATE, planId: null, planDates: null };
    await mount("v-off");
    assert.equal(selectedTab(), "SetupDefault");
    assert.equal(badge(), "Default");
    assert.equal(screen.queryByText(/For this plan/) === null, true);
  });

  test("Planning Center not connected is not unreachable: no notice, no plan, no plan list read", async () => {
    STATE = { ...STATE, pcoConfigured: false };
    UPCOMING = { ...UPCOMING, unavailable: "no credentials" };
    await mount();
    assert.equal(notice(), null);
    assert.equal(badge(), "Default");
    assert.equal(selectedTab(), "StandardDefault");
    assert.ok(!asked.includes("/api/plans/upcoming"), "the plan list was read with Planning Center not connected");
  });

  test("print's header line follows the same resolution", async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    assert.match(screen.getByTestId("print-page").querySelector("header")?.textContent ?? "", /For this plan · Sun 15 Nov/);
    await act(async () => {
      window.dispatchEvent(new Event("afterprint"));
    });
    await pushState({ planId: "plan-other" });
    await act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    const header = screen.getByTestId("print-page").querySelector("header")?.textContent ?? "";
    assert.match(header, /Default plot/);
    assert.doesNotMatch(header, /For this plan/);
  });
});
