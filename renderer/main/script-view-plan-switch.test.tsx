// script-view-plan-switch.test.tsx — a plan switch (or a service-type switch)
// whose new rundown read FAILS.
//
// The previous rundown used to stay on screen with nothing to say it no
// longer matched what the app was asking for: `showError`
// (scriptview-body.tsx) only draws when there is no rundown to fall back on,
// and a stale one from before the switch is still a rundown. An operator
// reading the wall saw the wrong department's or the wrong plan's items,
// with no sign anything was wrong — worse than showing nothing.
//
// Driven through the real component with a stubbed fetch and a fake SSE
// stream, since the app's active plan/service-type arrives over
// `stage:state-changed`, not a read this page issues itself. NOTHING BELOW
// PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to
// build its failure message, and inspecting a live jsdom element does not
// finish in any useful time. Every query is coerced to a boolean or a string
// first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ScriptView } = await import("./script-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The stream replays its last frame to a late subscriber, so without this the
// SECOND test's fresh mount immediately replays the FIRST test's last pushed
// state before its own hydrate has a say.
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN_P1 = {
  serviceTypeId: "st1",
  planId: "p1",
  planTitle: "Sunday service",
  planSeriesTitle: null,
  planDates: null,
  items: [],
  noteCategories: [],
  serviceTimes: [],
  timeZone: null,
  isActivePlan: false,
  isDefaultPlan: true,
};

const STATE_P1 = { serviceTypeId: "st1", planId: "p1", pcoConfigured: true };
/** Same type, a different plan — the "operator picks the next occurrence" case
 *  the code comments call out by name. */
const STATE_P2 = { serviceTypeId: "st1", planId: "p2", pcoConfigured: true };

/** `switched` flips once the test pushes the new state; the rundown route has
 *  no planId to answer by (the client only ever sends `serviceTypeId`), so
 *  this stands in for "the server's answer for the NEW plan". */
function stubFetch() {
  let switched = false;
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok(STATE_P1);
    if (url.includes("/api/scriptview/layouts")) return ok([]);
    if (url.includes("/api/scriptview/roles")) return ok([]);
    if (url.includes("/api/scriptview/rundown")) return switched ? reply(500, { error: "boom" }) : ok(RUNDOWN_P1);
    if (url.includes("/api/pco/live")) return ok(null);
    return ok({});
  });
  return { ...f, switchToNewPlan: () => { switched = true; } };
}

async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ScriptView, { scriptViewLayoutId: null })));
  await settle();
  await settle();
  await settle();
}

test("a plan switch whose new rundown fails to load drops the stale one, rather than keeping it on screen", async () => {
  const f = stubFetch();
  try {
    await mount();
    assert.equal(document.body.textContent?.includes("Sunday service"), true, "the first plan's title is on screen");
    f.switchToNewPlan();
    await act(async () => FakeEventSource.last?.push("stage:state-changed", STATE_P2));
    await settle();
    await settle();
    assert.equal(
      document.body.textContent?.includes("Sunday service"),
      false,
      "the previous plan must not still read as current once the app has moved on",
    );
    assert.equal(!!screen.queryByRole("alert"), true, "the failure is shown, since there is nothing good left to fall back on");
  } finally {
    f.restore();
  }
});

test("control: a plan switch whose new rundown SUCCEEDS shows the new plan, not the old one", async () => {
  const RUNDOWN_P2 = { ...RUNDOWN_P1, planId: "p2", planTitle: "Youth night" };
  let onP2 = false;
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok(STATE_P1);
    if (url.includes("/api/scriptview/layouts")) return ok([]);
    if (url.includes("/api/scriptview/roles")) return ok([]);
    if (url.includes("/api/scriptview/rundown")) return ok(onP2 ? RUNDOWN_P2 : RUNDOWN_P1);
    if (url.includes("/api/pco/live")) return ok(null);
    return ok({});
  });
  try {
    await mount();
    assert.equal(document.body.textContent?.includes("Sunday service"), true);
    onP2 = true;
    await act(async () => FakeEventSource.last?.push("stage:state-changed", STATE_P2));
    await settle();
    await settle();
    assert.equal(document.body.textContent?.includes("Youth night"), true, "the new plan loaded in");
    assert.equal(document.body.textContent?.includes("Sunday service"), false, "the previous plan is gone");
  } finally {
    f.restore();
  }
});
