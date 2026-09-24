// scriptview-index-reads.test.tsx — the ScriptView launcher at /scriptview.
//
// Its one read listed Planning Center's service types beside this app's
// layouts, and printed whatever came back when that failed. Planning Center not
// connected then read as a red error ("PCO not configured — add App ID…"), and a
// failure that was real reached no log. Not connected is now a state, said
// plainly with nothing read; a real failure is an ErrorNote and a line.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

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
const { ScriptViewIndex } = await import("./scriptview-index-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The stage state is one cache for the whole page, and the stream replays its
// last frame to a late subscriber; both are reset so no case starts in the
// state the one above it left.
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

interface Setup {
  pcoConfigured?: boolean;
  failing?: "load" | "state";
  /** Read at call time, so a test can let a later read through. */
  live?: { loadFails: boolean };
}

function stubFetch({ pcoConfigured = true, failing, live }: Setup = {}) {
  const asked: string[] = [];
  const f = stubFetchWithLog((url) => {
    asked.push(url);
    if (url.includes("/api/state")) {
      if (failing === "state") throw new TypeError("fetch failed");
      return ok({ pcoConfigured });
    }
    if (url.includes("/api/service-types")) {
      if (failing === "load" || live?.loadFails) throw new TypeError("fetch failed");
      if (!pcoConfigured) return reply(502, { error: "PCO not configured — add App ID and Secret in Integrations settings" });
      return ok([{ id: "st1", name: "Weekend" }]);
    }
    if (url.includes("/api/scriptview/layouts")) return ok([]);
    if (url.includes("/api/scriptview/config")) return ok({ serviceTypeIds: ["st1"] });
    return ok({});
  });
  return { ...f, asked };
}

async function mount(): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ScriptViewIndex)));
  await settle();
  await settle();
  await settle();
}

test("Planning Center not connected says to connect it — no alert, no log, nothing read", async () => {
  const f = stubFetch({ pcoConfigured: false });
  try {
    await mount();
    assert.equal(!!screen.queryByText(/Connect Planning Center to use ScriptView/i), true);
    assert.equal(!!screen.queryByText(/PCO not configured/i), false, "not an error printed from the server");
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
    assert.equal(f.asked.some((u) => u.includes("/api/service-types")), false, "without credentials the read can only fail");
  } finally {
    f.restore();
  }
});

test("a failed read on a connected server says so, and reaches the log", async () => {
  const f = stubFetch({ failing: "load" });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load ScriptView's service types and layouts/i);
    assert.ok(
      f.logs.some((l) => l.tag === "scriptview" && /service types and layouts/.test(l.message)),
      `expected a [scriptview] line — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a stage state that cannot be read does not leave the launcher spinning for ever", async () => {
  const f = stubFetch({ failing: "state" });
  try {
    await mount();
    assert.equal(!!screen.queryByText("Weekend"), true, "the service types are still read, and listed");
  } finally {
    f.restore();
  }
});

test("a failure a later read answers is taken away", async () => {
  // The read fails; Planning Center is disconnected and connected again, which
  // is what makes the launcher read again — and this time it works.
  const live = { loadFails: true };
  const f = stubFetch({ live });
  try {
    await mount();
    assert.match(alerts(), /Couldn't load ScriptView's service types and layouts/i);
    live.loadFails = false;
    await act(async () => FakeEventSource.last?.push("stage:state-changed", { pcoConfigured: false }));
    await settle();
    await act(async () => FakeEventSource.last?.push("stage:state-changed", { pcoConfigured: true }));
    await settle();
    await settle();
    assert.equal(alerts(), "", "the read that worked is the page now");
    assert.equal(!!screen.queryByText("Weekend"), true);
  } finally {
    f.restore();
  }
});

test("control: connected, the enabled service types are listed with no alert", async () => {
  const f = stubFetch();
  try {
    await mount();
    assert.equal(!!screen.queryByText("Weekend"), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
