// session-chart-refetch.test.tsx — the Session chart's timer lane is
// change-driven, not polled.
//
// Driven through the REAL renderer/lib/api.ts, with a fake EventSource, the
// same harness history-chart-live.test.tsx uses and for the same reason: the
// thing under test IS the plumbing — that a "baptism:state" push reaches
// useSessionLane's refetch — and a props-only test would prove the hook and
// skip exactly that. mock.timers proves the other half: a chart that polled on
// an interval would rack up extra fetches as fake time advances even with no
// push at all, and this asserts it does not.

import assert from "node:assert/strict";
import { after, afterEach, describe, mock, test } from "node:test";

import { installDom } from "../../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A fake EventSource that hands the test its channel listeners to fire —
 *  copied from history-chart-live.test.tsx rather than shared, because a
 *  module-scoped `EventSource` global cannot be shared across two test FILES
 *  (node:test runs each in its own process, but a local copy keeps this file
 *  runnable on its own with --test-name-pattern, per this repo's convention). */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
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

const { renderHook, act, cleanup } = await import("@testing-library/react");
const { useSessionLane } = await import("./session-chart.js");

afterEach(() => cleanup());
after(() => {
  cleanup();
  teardown();
});

/** Let a resolved fetch promise and the state update it triggers land.
 *  setImmediate is real even while setTimeout/setInterval are mocked — see
 *  plan-attachment-retry.test.tsx, which established this idiom. */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
}

function stubLaneFetch() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/baptism/lane")) {
      calls.push(url);
      return new Response(JSON.stringify({ spans: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const KEY = "st1:plan1:refetch-guard";

describe("useSessionLane refetches on baptism:state, and only on it", () => {
  test("two pushes are exactly two refetches, and a minute of idle time is none", async (t) => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const f = stubLaneFetch();
    // A cached "baptism:state" frame is module-level state (see api.ts) and
    // would otherwise leak between tests in this file — a run order where the
    // replay test runs first would hand THIS test's first subscriber a
    // surprise replay.
    const { __resetReplayCacheForTests } = await import("../../../lib/api.js");
    __resetReplayCacheForTests();
    t.after(() => {
      f.restore();
      mock.timers.reset();
      __resetReplayCacheForTests();
    });

    renderHook(() => useSessionLane(KEY));
    await flush();
    assert.equal(f.calls.length, 1, "the mount hydrate never fetched the lane");

    const es = FakeEventSource.last!;
    assert.ok(es, "useSessionLane did not open the event stream at all");

    // Idle time alone — no push — must never fetch. This is what a polling
    // implementation (setInterval(fetchLane, …)) would fail: ticking a minute
    // forward would rack up several extra calls here.
    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(f.calls.length, 1, "fetched the lane on a timer with no push at all — that is polling");

    await act(async () => es.push("baptism:state", { phase: "testimony", personNumber: 1, serviceKey: KEY }));
    await flush();
    assert.equal(f.calls.length, 2, "a live baptism:state push did not refetch the lane");

    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(f.calls.length, 2, "idle time between two pushes fetched the lane again — that is polling");

    await act(async () => es.push("baptism:state", { phase: "baptism", personNumber: 1, serviceKey: KEY }));
    await flush();
    assert.equal(f.calls.length, 3, "a second push did not refetch the lane");

    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(f.calls.length, 3, "exactly two pushes must mean exactly two refetches beyond the mount hydrate");
  });

  // This hook also backs HistorySessionChart, the read-only PAST-service view
  // on a service's History page — open on a service that finished weeks ago
  // while somewhere else in the building an unrelated live baptism is
  // pressing buttons on ITS OWN service. Every one of those presses
  // broadcasts this exact channel; none of them can have changed a lane that
  // finished weeks ago.
  test("a push naming a DIFFERENT service's key never refetches this one's lane", async (t) => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const f = stubLaneFetch();
    const { __resetReplayCacheForTests } = await import("../../../lib/api.js");
    __resetReplayCacheForTests();
    t.after(() => {
      f.restore();
      mock.timers.reset();
      __resetReplayCacheForTests();
    });

    renderHook(() => useSessionLane(KEY));
    await flush();
    assert.equal(f.calls.length, 1, "the mount hydrate never fetched the lane");
    const es = FakeEventSource.last!;

    await act(async () =>
      es.push("baptism:state", { phase: "testimony", personNumber: 1, serviceKey: "st1:plan1:some-other-service" }),
    );
    await flush();
    assert.equal(f.calls.length, 1, "a push for an unrelated service's own key refetched this one's lane");

    // The SAME service's own key still must refetch — this is not "never
    // refetch on a push," only "never refetch on someone ELSE's push."
    await act(async () => es.push("baptism:state", { phase: "baptism", personNumber: 1, serviceKey: KEY }));
    await flush();
    assert.equal(f.calls.length, 2, "a push naming this hook's own service must still refetch");
  });

  test("a late subscriber's replayed frame is not a second live push", async (t) => {
    // "baptism:state" is a HYDRATED channel (see sse-channels.ts): a subscriber
    // that mounts after a frame has already gone out — the Baptisms tab opened
    // mid-service is the ordinary case — is handed that frame back once, with
    // replayed=true (api.ts, queueMicrotask). Proving this needs TWO
    // subscribers: the first's live push is what populates the cache, and the
    // second's own mount is what receives the replay.
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const f = stubLaneFetch();
    const { __resetReplayCacheForTests } = await import("../../../lib/api.js");
    __resetReplayCacheForTests();
    t.after(() => {
      f.restore();
      mock.timers.reset();
      __resetReplayCacheForTests();
    });

    const a = renderHook(() => useSessionLane(KEY));
    await flush();
    assert.equal(f.calls.length, 1, "A's own mount hydrate");
    const es = FakeEventSource.last!;
    await act(async () => es.push("baptism:state", { phase: "testimony", personNumber: 1, serviceKey: KEY }));
    await flush();
    assert.equal(f.calls.length, 2, "A's live push refetched — see the first test");

    // B mounts into a channel that already has a cached frame.
    const before = f.calls.length;
    renderHook(() => useSessionLane(KEY));
    await flush();
    assert.equal(
      f.calls.length,
      before + 1,
      "a late subscriber's replay caused an extra fetch beyond its own mount hydrate",
    );

    a.unmount();
  });
});
