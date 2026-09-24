// scriptview-section-reads.test.tsx — the ScriptView settings page, when a read
// fails, and when Planning Center is simply not connected.
//
// Reads here rendered a failure as something else:
//
//   the settings          "No layouts yet" with an Add layout button, and Save
//                         writes the WHOLE list, so adding one would have
//                         replaced every real layout on the server
//   note categories       `.catch(() => setNoteCats([]))`: no categories to
//                         add to a role, as though the type had none
//   the preview's plan    `.catch(() => setRundown(null))`: "Loading plan…"
//                         for ever
//
// And not connected is a state, not a failure: the service types, and each
// type's categories and plan, are Planning Center's. Without credentials the
// service types answer 502 and the rest answer empty, so none of them is asked
// for, the preview says to connect, and the layouts editor still works.
//
// Driven through the real component with a stubbed fetch. NOTHING BELOW PASSES
// A DOM NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to build its
// failure message, and inspecting a live jsdom element does not finish in any
// useful time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

/** A stream a test can push on, as the server's SSE does. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onopen: unknown = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }
  close(): void {}
  push(channel: string, payload: unknown): void {
    for (const fn of this.listeners.get(channel) ?? []) fn({ data: JSON.stringify(payload) } as MessageEvent);
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { ScriptViewSection } = await import("./scriptview-section.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The stage state is one cache for the whole page, and the stream replays its
// last frame to a late subscriber; without both resets, one case's
// `pcoConfigured` is the next case's starting state.
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN: ScriptViewRundownDTO = {
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
};

type Read = "layouts" | "types" | "noteCats" | "rundown";

interface Setup {
  failing?: Read | "state";
  pcoConfigured?: boolean;
  /** Answer a note-category read by service type, for the races below. */
  noteCats?: (typeId: string) => unknown;
  /** Answer a plan read by service type. */
  rundown?: (typeId: string) => unknown;
  /** Answer the landing-page config read — held back, in the ordering test. */
  config?: () => unknown;
  /** Answer the service-type read — held back, or with a status. */
  types?: () => unknown;
}

const typeOf = (url: string) => new URL(url, "http://x").searchParams.get("serviceTypeId") ?? "";

const TYPES = [{ id: "st1", name: "Weekend" }, { id: "st2", name: "Youth" }];

function stubFetch({ failing, pcoConfigured = true, noteCats, rundown, config, types }: Setup = {}) {
  const asked: string[] = [];
  const f = stubFetchWithLog((url) => {
    asked.push(url);
    const read = (name: Read | "state", json: unknown) => {
      if (failing === name) throw new TypeError("fetch failed");
      return ok(json);
    };
    if (url.includes("/api/state")) return read("state", { pcoConfigured });
    if (url.includes("/api/service-types")) return types ? types() : read("types", TYPES);
    if (url.includes("/api/scriptview/layouts")) return read("layouts", [{ id: "svl1", name: "Audio", order: 0, columnRoles: [] }]);
    if (url.includes("/api/scriptview/config")) return config ? config() : ok({ serviceTypeIds: ["st1"] });
    if (url.includes("/api/scriptview/roles")) return ok([{ id: "r1", name: "Sound", members: [] }]);
    if (url.includes("/api/scriptview/note-categories")) return noteCats ? noteCats(typeOf(url)) : read("noteCats", ["Audio", "Lighting"]);
    if (url.includes("/api/scriptview/rundown")) return rundown ? rundown(typeOf(url)) : read("rundown", RUNDOWN);
    return ok({});
  });
  return { ...f, asked };
}

const previewWith = () => (screen.getByRole("combobox", { name: "Preview with" }) as HTMLSelectElement).value;
/** What the Preview with picker reads as: its selected option's text. */
const previewShows = () =>
  (screen.getByRole("combobox", { name: "Preview with" }) as HTMLSelectElement).selectedOptions[0]?.textContent ?? "";

async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ScriptViewSection)));
  await settle();
  await settle();
  await settle();
}

/** Open the Audio layout's card, which is where its preview draws. */
async function openLayout(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  await settle();
}

const logged = (logs: { tag: string; message: string }[], re: RegExp) =>
  logs.some((l) => l.tag === "scriptview" && re.test(l.message));

test("a failed settings read says so, and offers no empty list to Add a layout to", async () => {
  const f = stubFetch({ failing: "layouts" });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the ScriptView layouts/i);
    assert.equal(!!screen.queryByText(/No layouts yet/i), false, "a failed read is not an empty layout list");
    assert.equal(
      !!screen.queryByRole("button", { name: /Add layout/i }),
      false,
      "adding to a list that never loaded would save over every real layout",
    );
    assert.ok(logged(f.logs, /layouts/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed service-type read costs the previews, never the layouts editor", async () => {
  const f = stubFetch({ failing: "types" });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the service types/i);
    assert.equal(/ScriptView layouts/i.test(alerts()), false, "the layouts themselves loaded");
    assert.equal(!!screen.queryByDisplayValue("Audio"), true, "the layout is there to edit");
    assert.ok(logged(f.logs, /the service types/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("Planning Center not connected: the editor works, nothing alerts or logs, nothing of Planning Center's is asked for", async () => {
  const f = stubFetch({ pcoConfigured: false });
  try {
    await mount();
    await openLayout();
    assert.equal(!!screen.queryByDisplayValue("Audio"), true, "the layouts editor works without Planning Center");
    assert.equal(!!screen.queryByText(/Connect Planning Center to preview a plan/i), true);
    assert.equal(alerts(), "", "not connected is a state, not a failure");
    assert.deepEqual(f.logs, []);
    for (const route of ["/api/service-types", "/api/scriptview/note-categories", "/api/scriptview/rundown"]) {
      assert.equal(f.asked.some((u) => u.includes(route)), false, `${route} can only fail without credentials`);
    }
  } finally {
    f.restore();
  }
});

test("a failed note-category read says so, above the previews and inside the roles panel", async () => {
  const f = stubFetch({ failing: "noteCats" });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load this service type's note categories/i);
    fireEvent.click(screen.getByRole("button", { name: /Category roles/i }));
    await settle();
    assert.equal(
      screen.queryAllByRole("alert").filter((n) => /note categories/i.test(n.textContent ?? "")).length,
      2,
      "the roles panel says it too: without it, no + Add category reads as a type with none",
    );
    assert.ok(logged(f.logs, /note categories/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a slow failure for the type the operator left does not land on the type they chose", async () => {
  // Weekend's categories are still being read when the operator switches the
  // preview to Youth; Youth's answer, and only then Weekend's failure.
  let failWeekend: (e: Error) => void = () => {};
  const f = stubFetch({
    noteCats: (typeId) => (typeId === "st1" ? new Promise((_, reject) => { failWeekend = reject; }) : ok(["Audio"])),
  });
  try {
    await mount();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview with" }), { target: { value: "st2" } });
    await settle();
    await settle();
    await act(async () => failWeekend(new TypeError("fetch failed")));
    await settle();
    assert.equal(alerts(), "", "Weekend's read no longer applies; its failure is not Youth's");
  } finally {
    f.restore();
  }
});

test("a note-category failure for the type the operator left goes with it", async () => {
  // Weekend's categories FAIL, promptly; the operator switches to Youth, whose
  // categories load. The note was Weekend's, and must not stay for Youth.
  const f = stubFetch({ noteCats: (typeId) => (typeId === "st1" ? Promise.reject(new TypeError("fetch failed")) : ok(["Video"])) });
  try {
    await mount();
    assert.match(alerts(), /note categories/i);
    fireEvent.change(screen.getByRole("combobox", { name: "Preview with" }), { target: { value: "st2" } });
    await settle();
    await settle();
    assert.equal(alerts(), "", "Youth's categories loaded");
  } finally {
    f.restore();
  }
});

test("the plan the operator left, answering late, is not previewed as the one they chose", async () => {
  let answerWeekend: (v: unknown) => void = () => {};
  const f = stubFetch({
    rundown: (typeId) =>
      typeId === "st1"
        ? new Promise((resolve) => { answerWeekend = resolve; }).then((json) => ok(json))
        : ok({ ...RUNDOWN, serviceTypeId: "st2", planTitle: "Youth night" }),
  });
  try {
    await mount();
    await openLayout();
    fireEvent.change(screen.getByRole("combobox", { name: "Preview with" }), { target: { value: "st2" } });
    await settle();
    await settle();
    await act(async () => answerWeekend({ ...RUNDOWN, planTitle: "Weekend service" }));
    await settle();
    assert.equal(!!screen.queryByText("Youth night"), true, "the preview is Youth's plan");
    assert.equal(!!screen.queryByText("Weekend service"), false, "Weekend's late answer no longer applies");
  } finally {
    f.restore();
  }
});

test("the landing page's first enabled type is the preview default, whichever read answers first", async () => {
  // Youth is the only type the landing page shows; Planning Center lists
  // Weekend first. The settings are held back until the service types have had
  // every chance to answer first.
  let answerConfig: () => void = () => {};
  const f = stubFetch({
    config: () => new Promise((resolve) => { answerConfig = () => resolve(ok({ serviceTypeIds: ["st2"] })); }),
  });
  try {
    render(React.createElement(TooltipProvider, null, React.createElement(ScriptViewSection)));
    await settle();
    await settle();
    await act(async () => answerConfig());
    await settle();
    await settle();
    await settle();
    assert.equal(previewWith(), "st2", "the landing page's own first type, not Planning Center's first");
  } finally {
    f.restore();
  }
});

test("while the service types are on their way, the preview picker waits rather than calling its default 'not found'", async () => {
  // The settings answer first and name the landing page's first type; the
  // picker cannot name it until Planning Center has.
  let answerTypes: () => void = () => {};
  const f = stubFetch({ types: () => new Promise((resolve) => { answerTypes = () => resolve(ok(TYPES)); }) });
  try {
    await mount();
    assert.equal(/not found/i.test(previewShows()), false, `the picker reads "${previewShows()}"`);
    assert.match(previewShows(), /Loading service types/i);
    await act(async () => answerTypes());
    await settle();
    await settle();
    assert.equal(previewShows(), "Weekend", "then the landing page's first type, by name");
  } finally {
    f.restore();
  }
});

test("Planning Center not connected: the preview picker says to connect it, never 'not found'", async () => {
  const f = stubFetch({ pcoConfigured: false });
  try {
    await mount();
    assert.equal(/not found/i.test(previewShows()), false, `the picker reads "${previewShows()}"`);
    assert.match(previewShows(), /Connect Planning Center/i);
  } finally {
    f.restore();
  }
});

test("a failure from before the state said not connected gives way to the connect prompt", async () => {
  // The state could not be read, so the service types were tried — and answered
  // as they do without credentials. Then the state arrives.
  const f = stubFetch({
    failing: "state",
    types: () => reply(502, { error: "PCO not configured — add App ID and Secret in Integrations settings" }),
  });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the service types/i, "tried while the state was unknown, and failed");
    await act(async () => FakeEventSource.last?.push("stage:state-changed", { pcoConfigured: false }));
    await settle();
    assert.equal(alerts(), "", "not connected is a state, not a failure");
    assert.match(previewShows(), /Connect Planning Center/i);
  } finally {
    f.restore();
  }
});

test("a stage state that cannot be read does not leave the page waiting for ever", async () => {
  const f = stubFetch({ failing: "state" });
  try {
    await mount();
    assert.equal(f.asked.some((u) => u.includes("/api/service-types")), true, "the service types are still tried");
    assert.equal(!!screen.queryByRole("option", { name: "Weekend" }), true, "and the picker fills");
  } finally {
    f.restore();
  }
});

test("a failed plan read says so in the preview, not 'Loading plan…' for ever", async () => {
  const f = stubFetch({ failing: "rundown" });
  try {
    await mount();
    await openLayout();
    assert.match(alerts(), /Couldn't load the plan to preview/i);
    assert.equal(!!screen.queryByText(/Loading plan/i), false, "the read has finished; it failed");
    assert.equal(!!screen.queryByText(/No upcoming plan/i), false, "and it is not an empty plan either");
    assert.ok(logged(f.logs, /plan/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("control: every read loads, the preview reaches its own empty state, nothing alerts", async () => {
  const f = stubFetch();
  try {
    await mount();
    await openLayout();
    assert.equal(!!screen.queryByText(/No upcoming plan for this service type/i), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
