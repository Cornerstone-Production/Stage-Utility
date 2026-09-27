// patch-weekly.test.tsx — the Weekly assignment panel, when a read fails and when
// Planning Center is simply not connected.
//
// Both of the panel's reads used to `.catch(() => set…([]))`. A failed
// service-type read then told the operator to "Connect Planning Center" on a
// server where it is connected, and a failed stage-state read quietly listed
// every service type, as though the Plan tab enabled them all.
//
// Not connected is the other half, and a state rather than a failure: with no
// credentials `/api/service-types` answers 502 "PCO not configured", so the
// panel must not ask, and must not call it an error.
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

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { PatchWeekly } = await import("./patch-weekly.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The panel reads the page's one stage state, which is cached for the whole
// page; without the resets, one case's state is the next case's starting one.
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const TYPES: ServiceTypeDTO[] = [
  { id: "st1", name: "Weekend" },
  { id: "st2", name: "Youth" },
];

interface Setup {
  pcoConfigured?: boolean;
  failing?: "types" | "state";
  types?: ServiceTypeDTO[];
  allowed?: string[];
}

/** Answer the panel's two reads the way the server does; every URL asked for
 *  is kept, so a test can say which were never requested. */
function stubFetch({ pcoConfigured = true, failing, types = TYPES, allowed = [] }: Setup = {}) {
  const asked: string[] = [];
  const f = stubFetchWithLog((url) => {
    asked.push(url);
    if (url.includes("/api/service-types")) {
      if (failing === "types") throw new TypeError("fetch failed");
      // What the route answers without credentials.
      if (!pcoConfigured) return reply(502, { error: "PCO not configured — add App ID and Secret in Integrations settings" });
      return ok(types);
    }
    if (url.includes("/api/state")) {
      if (failing === "state") throw new TypeError("fetch failed");
      return ok({ allowedServiceTypeIds: allowed, pcoConfigured });
    }
    return ok({});
  });
  return { ...f, asked };
}

/** Mount, let the reads settle, and open the panel — its body is not in the
 *  DOM while it is collapsed. */
async function mount(): Promise<void> {
  render(
    React.createElement(PatchWeekly, {
      variants: [],
      assignments: { byServiceType: {}, byPlan: {} },
      plan: null,
      onChange: () => {},
    }),
  );
  await settle();
  await settle();
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Weekly assignment/i }));
  await settle();
}

test("a failed service-type read on a connected server says so, never 'Connect Planning Center'", async () => {
  const f = stubFetch({ failing: "types" });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the service types/i);
    assert.equal(
      !!screen.queryByText(/Connect Planning Center/i),
      false,
      "a failed read must not tell the operator to connect a Planning Center that is connected",
    );
    assert.ok(
      f.logs.some((l) => l.tag === "patch" && /the service types/i.test(l.message)),
      `expected a [patch] line naming the service types — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a failed Plan-tab filter read lists every type and says why, on the log too", async () => {
  const f = stubFetch({ failing: "state" });
  try {
    await mount();
    assert.equal(!!screen.queryByText("Weekend"), true);
    assert.equal(!!screen.queryByText("Youth"), true);
    assert.match(alerts(), /Couldn't load which service types the Plan tab enables/i);
    assert.ok(
      f.logs.some((l) => l.tag === "patch" && /Plan tab/i.test(l.message)),
      `expected a [patch] line naming the Plan tab's filter — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("Planning Center not connected says to connect it — no alert, no log, no service-type read", async () => {
  const f = stubFetch({ pcoConfigured: false });
  try {
    await mount();
    assert.equal(!!screen.queryByText(/Connect Planning Center/i), true);
    assert.equal(alerts(), "", "not connected is a state, not a failure");
    assert.deepEqual(f.logs, []);
    assert.equal(
      f.asked.some((u) => u.includes("/api/service-types")),
      false,
      "without credentials the read can only fail, so it is not made",
    );
  } finally {
    f.restore();
  }
});

test("control: connected with no service types says there are none to assign, with no alert", async () => {
  const f = stubFetch({ types: [] });
  try {
    await mount();
    assert.equal(!!screen.queryByText(/No service types to assign/i), true);
    assert.equal(!!screen.queryByText(/Connect Planning Center/i), false, "it IS connected");
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});

test("control: a filter that loads narrows the list, with no alert", async () => {
  const f = stubFetch({ allowed: ["st1"] });
  try {
    await mount();
    assert.equal(!!screen.queryByText("Weekend"), true);
    assert.equal(!!screen.queryByText("Youth"), false, "the Plan tab enables only Weekend");
    assert.equal(alerts(), "");
  } finally {
    f.restore();
  }
});
