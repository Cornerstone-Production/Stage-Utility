// servicecue-all-columns.test.tsx — All columns shows every note category.
//
// "All columns" is every role. A category in no role is in none of them, so a department
// whose category someone added in Planning Center this week showed nowhere, and nothing
// said so. All columns now appends each category that is in no role, after the roles, in
// the order Planning Center lists them; a named layout still shows only its own roles.
// Roles are not created: this changes what is drawn, not what is saved.
//
// Driven through the real page (every surface draws its columns through the one resolver,
// resolveServiceCueSpec) and against the resolver itself.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup, act } = await import("@testing-library/react");
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

const ITEM = {
  id: "i1", title: "Opening song", itemType: "song", lengthSec: 240, servicePosition: "during",
  notesByCategory: { Audio: "Mics up", Lighting: "Warm wash", "Stage Manager": "Walk on" },
};
const RUNDOWN_WITH_NOTES = { ...RUNDOWN, items: [ITEM], noteCategories: ["Audio", "Lighting", "Stage Manager"] };

function stubFetch(roles: () => unknown = () => ok([{ id: "r1", name: "Sound", members: ["Audio"] }])) {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) return ok([{ id: "svl1", name: "Audio", slug: "audio", order: 0, columnRoles: ["r1"] }]);
    // Sound holds Audio; Lighting and Stage Manager are in no role.
    if (url.includes("/api/servicecue/roles")) return roles();
    if (url.includes("/api/servicecue/rundown")) return ok(RUNDOWN_WITH_NOTES);
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



const { resolveServiceCueSpec, buildServiceCueColumns } = await import("./servicecue-columns.js");

const headers = () => [...document.querySelectorAll("th, [role=columnheader]")].map((n) => n.textContent ?? "");

test("under All columns a category in no role gets a column, after the roles", async () => {
  const f = stubFetch();
  try {
    await mount("all-columns");
    const h = headers();
    assert.deepEqual(h.filter((x) => ["Sound", "Lighting", "Stage Manager"].includes(x)), ["Sound", "Lighting", "Stage Manager"], h.join("|"));
    assert.match(document.body.textContent ?? "", /Warm wash/);
    assert.match(document.body.textContent ?? "", /Walk on/);
  } finally {
    f.restore();
  }
});

test("until the roles have been read, no column is invented from the categories", async () => {
  let answer: () => void = () => {};
  const f = stubFetch(() => new Promise((resolve) => { answer = () => resolve(ok([{ id: "r1", name: "Sound", members: ["Audio"] }])); }));
  try {
    await mount("all-columns");
    // Every category is "in no role" while the roles are unknown; drawing them raw would
    // flash a table of Lighting and Audio columns and then regroup Audio under Sound.
    assert.doesNotMatch(document.body.textContent ?? "", /Warm wash|Mics up/);
    await act(async () => answer());
    await settle();
    assert.deepEqual(headers().filter((x) => ["Sound", "Audio", "Lighting"].includes(x)), ["Sound", "Lighting"]);
  } finally {
    f.restore();
  }
});

test("when the roles cannot be read, the note columns are not guessed at, and the page says so", async () => {
  const f = stubFetch(() => { throw new TypeError("fetch failed"); });
  try {
    await mount("all-columns");
    assert.match(document.body.textContent ?? "", /Couldn't load the category roles, so no note columns are shown/);
    assert.doesNotMatch(document.body.textContent ?? "", /Warm wash|Mics up/);
  } finally {
    f.restore();
  }
});

test("a named layout still shows only its own roles", async () => {
  const f = stubFetch();
  try {
    await mount("audio");
    assert.equal(document.title.endsWith("Audio"), true, document.title);
    assert.match(document.body.textContent ?? "", /Mics up/);
    assert.doesNotMatch(document.body.textContent ?? "", /Warm wash|Walk on/);
  } finally {
    f.restore();
  }
});

const ROLES = [
  { id: "r1", name: "Sound", members: ["Audio", "Audio/Visual"] },
  { id: "r2", name: "Band", members: ["Band"] },
];

test("a category already in a role is not shown twice, whatever its case", () => {
  const spec = resolveServiceCueSpec(null, ROLES, ["audio", "Band", "AUDIO/VISUAL", "Lighting"]);
  assert.deepEqual(spec.columns.map((c) => c.name), ["Sound", "Band", "Lighting"]);
});

test("case variants of one unassigned category are one column", () => {
  const spec = resolveServiceCueSpec(null, ROLES, ["Lighting", "lighting", "Video", ""]);
  assert.deepEqual(spec.columns.map((c) => c.name), ["Lighting", "Video"]);
  const light = buildServiceCueColumns(spec, null).find((c) => c.header === "Lighting");
  assert.equal(light?.render({ notesByCategory: { lighting: "dim" } } as never, {} as never), "dim");
});

test("the appended columns are told apart from roles by id, and from each other", () => {
  const spec = resolveServiceCueSpec(null, ROLES, ["Audio", "Lighting", "Video"]);
  const ids = spec.columns.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
  assert.deepEqual(ids.filter((id) => id.startsWith("category:")), ["category:lighting", "category:video"]);
});

test("a named layout never gets them, and a role whose members the type lacks is still hidden", () => {
  const layout = { id: "l", name: "Audio", order: 0, columnRoles: ["r1", "r2"] };
  assert.deepEqual(resolveServiceCueSpec(layout, ROLES, ["Audio", "Lighting"]).columns.map((c) => c.name), ["Sound"]);
  assert.deepEqual(resolveServiceCueSpec(null, ROLES, ["Audio"]).columns.map((c) => c.name), ["Sound"]);
});
