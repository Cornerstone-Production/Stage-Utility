// script-view-reads.test.tsx — the Script display (a View on a stage monitor),
// when its column layouts or roles cannot be read.
//
// Both reads ride the rundown's one-minute timer and "keep the last good list"
// when one fails. Before the first success there is no good list: the layouts
// start empty, an empty list resolves to ALL columns, and a monitor set to one
// department's columns showed every department's notes with nothing on screen
// to say so. A failure now says so while there is nothing to keep, and only
// then — once a list has loaded, a failed retry changes nothing on screen.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ScriptView } = await import("./script-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
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
};

type Read = "layouts" | "roles" | "rundown";

const CONNECTED = { serviceTypeId: "st1", planId: "p1", pcoConfigured: true };

/** `failing` is read at call time, so a test can change it between ticks. */
function stubFetch(failing: Read[], state: Record<string, unknown> = CONNECTED) {
  const asked: string[] = [];
  const f = stubFetchWithLog((url) => {
    asked.push(url);
    const read = (name: Read, json: unknown) => {
      if (failing.includes(name)) throw new TypeError("fetch failed");
      return ok(json);
    };
    if (url.includes("/api/state")) return ok(state);
    if (url.includes("/api/scriptview/layouts")) return read("layouts", [{ id: "svl-audio", name: "Audio", order: 0, columnRoles: ["r1"] }]);
    if (url.includes("/api/scriptview/roles")) return read("roles", [{ id: "r1", name: "Sound", members: ["Audio"] }]);
    if (url.includes("/api/scriptview/rundown")) return read("rundown", RUNDOWN);
    if (url.includes("/api/pco/live")) return ok(null);
    return ok({});
  });
  return { ...f, asked };
}

async function mount(scriptViewLayoutId: string | null = "svl-audio"): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ScriptView, { scriptViewLayoutId })));
  await settle();
  await settle();
  await settle();
}

const lines = (logs: { tag: string; message: string }[], re: RegExp) =>
  logs.filter((l) => l.tag === "scriptview" && re.test(l.message)).length;
const logged = (logs: { tag: string; message: string }[], re: RegExp) => lines(logs, re) > 0;

test("layouts that never loaded say the display fell back to all columns", async () => {
  const f = stubFetch(["layouts"]);
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the column layouts, so all columns are shown/i);
    assert.ok(logged(f.logs, /column layouts/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("roles that never loaded say the note columns are missing", async () => {
  const f = stubFetch(["roles"]);
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the category roles, so no note columns are shown/i);
    assert.ok(logged(f.logs, /category roles/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a display on All columns does not need the layouts, and says nothing about them", async () => {
  const f = stubFetch(["layouts"]);
  try {
    await mount(null);
    assert.equal(alerts(), "", "All columns is what it would show anyway");
  } finally {
    f.restore();
  }
});

test("once a list has loaded, a failed retry keeps it and changes nothing on screen", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const failing: Read[] = [];
  const f = stubFetch(failing);
  try {
    await mount();
    assert.equal(alerts(), "");
    failing.push("layouts", "roles");
    // Two ticks of the timer: a retry that keeps failing is one failure, not
    // one log line a minute.
    for (let i = 0; i < 2; i++) {
      await act(async () => t.mock.timers.tick(60_000));
      await settle();
      await settle();
    }
    assert.equal(alerts(), "", "the last good lists are still the right ones");
    assert.equal(lines(f.logs, /column layouts/i), 1, "the layouts failure is on /log, once");
    assert.equal(lines(f.logs, /category roles/i), 1, "the roles failure is on /log, once");
  } finally {
    f.restore();
  }
});

test("a rundown that cannot be read reaches the log", async () => {
  const f = stubFetch(["rundown"]);
  try {
    await mount();
    assert.ok(logged(f.logs, /could not read the rundown for a Script view/i), `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("Planning Center not connected: the display says so quietly and asks for no plan", async () => {
  const f = stubFetch([], { ...CONNECTED, pcoConfigured: false });
  try {
    await mount();
    assert.equal(document.body.textContent?.includes("Planning Center isn't connected, so this display can't find its plan."), true);
    assert.equal(alerts(), "", "not connected is a state, not a failure");
    assert.equal(f.asked.some((u) => u.includes("/api/scriptview/rundown")), false, "without credentials the plan can only come back empty");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});

test("no service type selected: the display says so quietly, not that Planning Center is missing", async () => {
  const f = stubFetch([], { ...CONNECTED, serviceTypeId: null, planId: null });
  try {
    await mount();
    assert.equal(document.body.textContent?.includes("No service type is selected, so this display has no plan to follow."), true);
    assert.equal(document.body.textContent?.includes("not configured"), false, "Planning Center is connected");
    assert.equal(alerts(), "");
  } finally {
    f.restore();
  }
});

test("control: both lists load, nothing alerts, nothing logs", async () => {
  const f = stubFetch([]);
  try {
    await mount();
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
