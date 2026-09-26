// use-service-live.test.ts — useServiceLive's own reaction to a
// "service-timeline:history" push must be exactly once per LIVE push, never
// once more for the REPLAYED connect-time cache a late subscriber is handed.
//
// "service-timeline:history" is a HYDRATED channel (sse-channels.ts): the
// EventSource captures every frame into a client-side cache from the moment
// it connects, whether or not anything is listening yet, and a NEW subscriber
// to a channel the cache already holds something for is handed that cached
// frame back once, with replayed=true (api.ts, queueMicrotask) — see
// session-chart-refetch.test.tsx's own "a late subscriber's replayed frame"
// test for the identical mechanism on a different channel. Reproducing this
// needs the same two-subscriber shape: the FIRST instance's own live push
// populates the cache, and the SECOND instance's mount is what receives the
// replay right alongside its own mount ask.

import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";

import { installDom } from "../../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Copied from session-chart-refetch.test.tsx rather than shared — a
 *  module-scoped `EventSource` global cannot be shared across test FILES. */
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
const { useServiceLive } = await import("./use-service-live.js");

afterEach(() => cleanup());
after(() => {
  cleanup();
  teardown();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
}

const KEY = "st1:plan1:service-live-guard";

test("a replayed service-timeline:history frame does not ask history:live a second time", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let liveCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/history/live")) {
      liveCalls += 1;
      return new Response(JSON.stringify({ live: false }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  const { __resetReplayCacheForTests } = await import("../../../lib/api.js");
  __resetReplayCacheForTests();
  t.after(() => {
    globalThis.fetch = realFetch;
    mock.timers.reset();
    __resetReplayCacheForTests();
  });

  // First instance: its own mount ask, then a LIVE push (not replayed) that
  // populates service-timeline:history's hydrate cache.
  const a = renderHook(() => useServiceLive(KEY));
  await flush();
  assert.equal(liveCalls, 1, "sanity: A's own mount asked history:live once");
  const es = FakeEventSource.last!;
  await act(async () => es.push("service-timeline:history", { serviceKey: KEY }));
  await flush();
  assert.equal(liveCalls, 2, "sanity: A's own live push re-asked history:live");
  a.unmount();

  // Second instance, same key: its OWN mount ask, PLUS the replayed
  // connect-time cache it is handed right alongside that mount (queueMicrotask)
  // — this must NOT be treated as a second live push.
  const before = liveCalls;
  renderHook(() => useServiceLive(KEY));
  await flush();
  assert.equal(
    liveCalls,
    before + 1,
    `a replayed service-timeline:history frame asked history:live again (calls went ${before} -> ${liveCalls}, expected ${before + 1})`,
  );
});
