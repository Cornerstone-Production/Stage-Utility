// scriptview-plan-view-reads.test.tsx — the standalone ScriptView page
// (/scriptview/{type}/{layout}), when one of its reads fails.
//
// All three reads used to `.catch(() => set…([]))`, and each failure drew a
// plausible page that was wrong:
//
//   service types   a slug URL never resolved, so the spinner turned for ever
//   layouts         the page fell back to All columns under the layout's URL
//   roles           every note column vanished, which reads as a plan with no
//                   notes in it
//
// Driven through the real component with a stubbed fetch. NOTHING BELOW PASSES
// A DOM NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to build its
// failure message, and inspecting a live jsdom element does not finish in any
// useful time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { alerts, ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

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

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ScriptViewPlan } = await import("./scriptview-plan-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

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

type Failing = "types" | "layouts" | "roles" | "state" | null;

/** `answers` replaces what a read gets back, for a status or a failure `failing` cannot say. */
function stubFetch(failing: Failing, pcoConfigured = true, answers: { types?: () => unknown; rundown?: () => unknown } = {}) {
  const asked: string[] = [];
  const f = stubFetchWithLog((url) => {
    asked.push(url);
    const read = (name: Exclude<Failing, null>, json: unknown) => {
      if (failing === name) throw new TypeError("fetch failed");
      return ok(json);
    };
    if (url.includes("/api/service-types")) return answers.types ? answers.types() : read("types", [{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/scriptview/layouts")) return read("layouts", [{ id: "svl1", name: "Audio", order: 0, columnRoles: ["r1"] }]);
    if (url.includes("/api/scriptview/roles")) return read("roles", [{ id: "r1", name: "Sound", members: ["Audio"] }]);
    if (url.includes("/api/scriptview/rundown")) return answers.rundown ? answers.rundown() : ok(RUNDOWN);
    if (url.includes("/api/pco/live")) return ok(null);
    if (url.includes("/api/state")) return read("state", { pcoConfigured });
    return ok({});
  });
  return { ...f, asked };
}

async function mount(serviceTypeParam = "weekend"): Promise<void> {
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ScriptViewPlan, { serviceTypeParam, layoutParam: "audio" }),
    ),
  );
  await settle();
  await settle();
  await settle();
}

const logged = (logs: { tag: string; message: string }[], re: RegExp) =>
  logs.some((l) => l.tag === "scriptview" && re.test(l.message));

test("a failed service-type read under a slug URL says so instead of spinning", async () => {
  const f = stubFetch("types");
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the service types/i);
    assert.ok(logged(f.logs, /service types/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed layout read says the page fell back to all columns", async () => {
  const f = stubFetch("layouts");
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the column layouts, so all columns are shown/i);
    assert.ok(logged(f.logs, /layouts/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed role read says the note columns are missing, rather than dropping them", async () => {
  const f = stubFetch("roles");
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the category roles, so no note columns are shown/i);
    assert.ok(logged(f.logs, /roles/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("Planning Center not connected says so quietly under a slug URL — no alert, no log, no service-type read", async () => {
  const f = stubFetch(null, false);
  try {
    await mount();
    assert.equal(!!screen.queryByText(/Planning Center isn't connected, so this page can't find its plan/i), true);
    assert.equal(alerts(), "", "not connected is a state, not a failed read");
    assert.deepEqual(f.logs, []);
    assert.equal(f.asked.some((u) => u.includes("/api/service-types")), false, "without credentials the read can only fail");
  } finally {
    f.restore();
  }
});

test("a stage state that cannot be read does not leave the page spinning for ever", async () => {
  const f = stubFetch("state");
  try {
    await mount();
    assert.equal(f.asked.some((u) => u.includes("/api/service-types")), true, "the service types are still tried");
    assert.equal(!!screen.queryByText(/No items in this plan/i), true, "and the slug resolves to its plan");
  } finally {
    f.restore();
  }
});

test("a failure from before the state said not connected gives way to the notice", async () => {
  // The state could not be read, so the service types were tried — and answered
  // as they do without credentials. Then the state arrives.
  const f = stubFetch("state", true, {
    types: () => reply(502, { error: "PCO not configured — add App ID and Secret in Integrations settings" }),
  });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the service types/i, "tried while the state was unknown, and failed");
    await act(async () => FakeEventSource.last?.push("stage:state-changed", { pcoConfigured: false }));
    await settle();
    assert.equal(!!screen.queryByText(/Planning Center isn't connected, so this page can't find its plan/i), true);
    assert.equal(alerts(), "", "not connected is the notice, not an error");
  } finally {
    f.restore();
  }
});

test("an id URL with Planning Center not connected says so too, and reads no plan", async () => {
  const f = stubFetch(null, false);
  try {
    await mount("12345");
    assert.equal(!!screen.queryByText(/Planning Center isn't connected, so this page can't find its plan/i), true);
    assert.equal(f.asked.some((u) => u.includes("/api/scriptview/rundown")), false, "without credentials the plan can only come back empty");
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});

test("a plan that cannot be read says so, and reaches the log", async () => {
  const f = stubFetch(null, true, {
    rundown: () => {
      throw new TypeError("fetch failed");
    },
  });
  try {
    await mount();
    assert.notEqual(alerts(), "", "the body says the plan could not load");
    assert.ok(logged(f.logs, /could not read the rundown for service type st1/), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("control: every read loads, the plan's own empty state shows, nothing alerts", async () => {
  const f = stubFetch(null);
  try {
    await mount();
    assert.equal(!!screen.queryByText(/No items in this plan/i), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
