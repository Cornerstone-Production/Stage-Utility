// servicecue-view-live-lists.test.tsx — an open ServiceCue screen picks up a layout or role
// edit when it is SAVED, not on its next timer.
//
// The screen used to read its layouts and roles on the rundown's one-minute timer, so a layout
// edited on /servicecue/presets reached it up to a minute later (a reload showed it at once).
// The server now says so on `servicecue:lists`, and the screen reads them again on a frame.
// The timer is left for two things: the rundown, which nothing announces a change to, and the
// retry of a layouts or roles read that FAILED (an empty list resolves to ALL columns, so a
// boot-time failure must not strand the screen there).
//
// Driven through the real component with a stubbed fetch and a fake SSE stream a test pushes
// on; the interval is mocked, so a read the tests see did not wait on a timer unless it ticked
// one. NOT asserted here, because jsdom lays nothing out: what the columns look like after the
// swap. That was driven in a browser against a real server. NOTHING BELOW PASSES A DOM NODE AS
// AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { alerts, ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { eventually, installRenderDom, isPlumbing, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ServiceCue } = await import("./servicecue-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN = {
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
const STATE = { serviceTypeId: "st1", planId: "p1", pcoConfigured: true };

type Read = "layouts" | "roles" | "rundown";

/** Counts what the screen asked for; `failing` is read at call time. */
function stubFetch(failing: Read[] = []) {
  const asked: Record<Read, number> = { layouts: 0, roles: 0, rundown: 0 };
  const f = stubFetchWithLog((url) => {
    if (isPlumbing(url)) return ok({});
    const read = (name: Read, json: unknown) => {
      asked[name]++;
      if (failing.includes(name)) throw new TypeError("fetch failed");
      return ok(json);
    };
    if (url.includes("/api/state")) return ok(STATE);
    if (url.includes("/api/servicecue/layouts")) return read("layouts", [{ id: "svl-audio", name: "Audio", order: 0, columnRoles: ["r1"] }]);
    if (url.includes("/api/servicecue/roles")) return read("roles", [{ id: "r1", name: "Sound", members: ["Audio"] }]);
    if (url.includes("/api/servicecue/rundown")) return read("rundown", RUNDOWN);
    if (url.includes("/api/pco/live")) return ok(null);
    return ok({});
  });
  return { ...f, asked };
}

async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ServiceCue, { serviceCueLayoutId: "svl-audio" })));
  await settle();
  await settle();
  await settle();
}

const LISTS = { epoch: "e1", seq: 1 };

test("a saved layout or role list is read again at once, with no timer, and the rundown is not", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = stubFetch();
  try {
    await mount();
    await eventually(() => assert.deepEqual(f.asked, { layouts: 1, roles: 1, rundown: 1 }));
    await act(async () => FakeEventSource.last?.push("servicecue:lists", LISTS));
    await settle();
    await eventually(() => assert.deepEqual(f.asked, { layouts: 2, roles: 2, rundown: 1 }));
  } finally {
    f.restore();
  }
});

test("a healthy screen does not read its layouts or roles on the timer; the rundown still does", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = stubFetch();
  try {
    await mount();
    await eventually(() => assert.deepEqual(f.asked, { layouts: 1, roles: 1, rundown: 1 }));
    await act(async () => t.mock.timers.tick(60_000));
    await settle();
    await eventually(() => assert.equal(f.asked.rundown, 2, "the rundown rides the timer"));
    assert.deepEqual([f.asked.layouts, f.asked.roles], [1, 1], "the lists are read when saved, not every minute");
  } finally {
    f.restore();
  }
});

test("a frame replayed to a screen that has just read for itself is not a reason to read again", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = stubFetch();
  try {
    await mount();
    await eventually(() => assert.equal(f.asked.layouts, 1));
    await act(async () => FakeEventSource.last?.push("servicecue:lists", LISTS));
    await settle();
    await eventually(() => assert.equal(f.asked.layouts, 2));
    // A second screen mounting into the open stream is handed the cached frame.
    cleanup();
    resetStageState();
    f.asked.layouts = f.asked.roles = 0;
    await mount();
    await settle();
    await settle();
    assert.deepEqual([f.asked.layouts, f.asked.roles], [1, 1], "the replay caused a second read");
  } finally {
    f.restore();
  }
});

test("a layouts and roles read that failed at boot is retried on the timer, and the screen recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const failing: Read[] = ["layouts", "roles"];
  const f = stubFetch(failing);
  try {
    await mount();
    await eventually(() => assert.match(alerts(), /Couldn't load the layouts, so all columns are shown/i));
    failing.length = 0;
    await act(async () => t.mock.timers.tick(60_000));
    await settle();
    await eventually(() => assert.equal(alerts(), "", "the retry never fired"));
    // Healed: the next minute asks for nothing more.
    const [l, r] = [f.asked.layouts, f.asked.roles];
    await act(async () => t.mock.timers.tick(60_000));
    await settle();
    assert.deepEqual([f.asked.layouts, f.asked.roles], [l, r]);
  } finally {
    f.restore();
  }
});

test("a read after a save that fails keeps the last good lists, says nothing on screen, and reaches /log once", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const failing: Read[] = [];
  const f = stubFetch(failing);
  try {
    await mount();
    await eventually(() => assert.deepEqual(f.asked, { layouts: 1, roles: 1, rundown: 1 }));
    failing.push("layouts", "roles");
    for (let seq = 2; seq <= 3; seq++) {
      await act(async () => FakeEventSource.last?.push("servicecue:lists", { epoch: "e1", seq }));
      await settle();
    }
    await eventually(() => assert.equal(f.asked.layouts, 3));
    const lines = (re: RegExp) => f.logs.filter((l) => l.tag === "servicecue" && re.test(l.message)).length;
    await eventually(() => assert.equal(lines(/the layouts for a ServiceCue view/i), 1, "the layouts failure is on /log, once"));
    assert.equal(lines(/category roles/i), 1, "the roles failure is on /log, once");
    assert.equal(alerts(), "", "the last good lists are still the right ones");
  } finally {
    f.restore();
  }
});
