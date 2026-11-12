// servicecue-plan-view-layout-url.test.tsx — which layout a rundown address opens.
//
// /servicecue/<type>/<layout> names a layout by its slug. A tablet pinned to one is
// the whole point of the address, so:
//
//   - the slug is the layout's STORED one: a layout renamed since it was created is
//     still found under the address it was pinned with
//   - an address naming no layout says so, above the All columns it falls back to,
//     rather than opening All columns as though that were asked for
//   - nothing is said before the layouts have answered (every pinned address would
//     flash it), and a failed read has its own note, not this one
//
// Driven through the real component with a stubbed fetch. NOTHING BELOW PASSES A DOM
// NODE AS AN ASSERT OPERAND — see servicecue-plan-view-reads.test.tsx.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ServiceCuePlan } = await import("./servicecue-plan-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The stage state is one cache for the whole page, and the stream replays its
// last frame to a late subscriber; without both resets, one case's
// `pcoConfigured` is the next case's starting state.
// The page asks for the plan switcher's list through react-query, as the real
// app's provider allows. A fresh client per case so one case's cached list is not
// the next one's starting state.
let queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
afterEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN: ServiceCueRundownDTO = {
  serviceTypeId: "st1",
  planId: "p1",
  planTitle: "Sunday",
  planSeriesTitle: null,
  planDates: null,
  items: [],
  noteCategories: [],
  serviceTimes: [],
  timeZone: null,
  isActivePlan: false,
  isDefaultPlan: true,
};

type Failing = "layouts" | null;

function stubFetch(failing: Failing, layouts: unknown[]) {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) {
      if (failing === "layouts") throw new TypeError("fetch failed");
      return ok(layouts);
    }
    if (url.includes("/api/servicecue/roles")) return ok([{ id: "r1", name: "Sound", members: ["Audio"] }]);
    if (url.includes("/api/servicecue/rundown")) return ok(RUNDOWN);
    if (url.includes("/api/pco/live")) return ok(null);
    if (url.includes("/api/state")) return ok({ pcoConfigured: true });
    return ok({});
  });
}

async function mount(layoutParam: string): Promise<void> {
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TooltipProvider, null, React.createElement(ServiceCuePlan, { serviceTypeParam: "weekend", layoutParam })),
    ),
  );
  await settle();
  await settle();
  await settle();
}


const page = () => document.body.textContent ?? "";

const PINNED = [{ id: "svl1", name: "Audio Crew", slug: "audio", order: 0, columnRoles: ["r1"] }];

test("an address finds a layout by its stored slug, whatever it is called now", async () => {
  const f = stubFetch(null, PINNED);
  try {
    await mount("audio");
    assert.equal(document.title.endsWith("Audio Crew"), true, document.title);
    assert.doesNotMatch(page(), /not found/);
  } finally {
    f.restore();
  }
});

test("an address naming no layout says so and shows All columns under it", async () => {
  const f = stubFetch(null, PINNED);
  try {
    await mount("audio-crew"); // the NEW name's slug: this is what a rename used to do to every pin
    assert.match(page(), /Layout "audio-crew" not found. Showing All columns./);
    assert.equal(screen.getByRole("alert").textContent, 'Layout "audio-crew" not found. Showing All columns.');
    assert.equal(document.title.endsWith("All columns"), true, document.title);
    // The fallback content stays under the notice.
    assert.match(page(), /Sunday/);
  } finally {
    f.restore();
  }
});

test("the All columns address is not a missing layout", async () => {
  const f = stubFetch(null, PINNED);
  try {
    await mount("all-columns");
    assert.doesNotMatch(page(), /not found/);
  } finally {
    f.restore();
  }
});

test("nothing is said while the layouts have not answered yet", async () => {
  let answer: () => void = () => {};
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/servicecue/layouts")) return new Promise((resolve) => { answer = () => resolve(ok(PINNED)); });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/rundown")) return ok(RUNDOWN);
    if (url.includes("/api/state")) return ok({ pcoConfigured: true });
    return ok(url.includes("/api/servicecue/roles") ? [] : {});
  });
  try {
    await mount("audio");
    assert.doesNotMatch(page(), /not found/, "every pinned address flashed the notice until the layouts arrived");
    await act(async () => answer());
    await settle();
    assert.doesNotMatch(page(), /not found/);
    assert.equal(document.title.endsWith("Audio Crew"), true, document.title);
  } finally {
    f.restore();
  }
});

test("a failed layouts read is not reported as a missing layout", async () => {
  const f = stubFetch("layouts", PINNED);
  try {
    await mount("audio");
    assert.match(page(), /Couldn't load the column layouts/);
    assert.doesNotMatch(page(), /not found/);
  } finally {
    f.restore();
  }
});
