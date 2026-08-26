import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// jsdom ships no EventSource, so stand one up before api.ts is evaluated. It
// only has to record wiring - nothing here asserts on delivered events.
class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  listeners: Array<[string, unknown]> = [];
  constructor(public url: string) {}
  addEventListener(type: string, fn: unknown) { this.listeners.push([type, fn]); }
  removeEventListener(type: string, fn: unknown) {
    const i = this.listeners.findIndex(([t, f]) => t === type && f === fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  close() { this.readyState = FakeEventSource.CLOSED; }
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

// No SharedWorker in jsdom, which is exactly the state this code handles.
const { __sseFallback } = await import("./api.js");

after(() => teardown());

// Falling back from the shared worker to a per-tab stream used to be a ONE-WAY
// door: sharedSse was set false permanently, so any transient hiccup pushed a
// tab onto its own connection for the rest of its life. Tab by tab, a machine
// would drift back to one stream per tab - the connection exhaustion the shared
// worker exists to prevent, arrived at slowly rather than all at once.
//
// Recovery introduced a second hazard: a RETRY that fails re-enters the fallback
// path while the previous fallback is still wired up. Rebuilding the wrappers
// then leaves two per channel, and every event is handled twice.
describe("shared SSE worker fallback bookkeeping", () => {
  beforeEach(() => __sseFallback.reset());

  test("a fallback actually builds wrappers, so the checks below are not vacuous", () => {
    // Asserting on listener COUNT instead of wrapper count hid a broken test:
    // jsdom has no SharedWorker, so workerHandlers stayed empty, no wrappers were
    // ever built, and the double-wrap test passed with its guard deleted.
    __sseFallback.seedWorkerHandler("stage:state");
    __sseFallback.simulateRetryStart(); // i.e. this tab was on the worker
    __sseFallback.abandon("first failure");
    assert.ok(
      __sseFallback.wrapperCount() > 0,
      "no wrappers were built — the double-wrap assertions below prove nothing",
    );
  });

  test("abandoning twice does not double-wrap the channels", () => {
    __sseFallback.seedWorkerHandler("stage:state");
    __sseFallback.simulateRetryStart(); // i.e. this tab was on the worker
    __sseFallback.abandon("first failure");
    const afterFirst = __sseFallback.wrapperCount();

    // The path that actually double-wraps: a retry flips sharedSse back on, then
    // ensureWorker() fails and drops straight back into abandonWorker. Calling
    // abandon() twice plainly does NOT reach this - the second call early-returns
    // - and a test that skipped this step passed with the guard deleted.
    __sseFallback.simulateRetryStart();
    __sseFallback.abandon("a retry that failed");
    assert.equal(
      __sseFallback.wrapperCount(),
      afterFirst,
      "a second fallback rebuilt the wrappers — every event would be handled twice",
    );
  });

  test("the callback registry survives a fallback, so recovery has something to restore", () => {
    __sseFallback.seedWorkerHandler("stage:state");
    __sseFallback.simulateRetryStart();
    const before = __sseFallback.handlerChannels();
    __sseFallback.abandon("worker died");
    assert.deepEqual(
      __sseFallback.handlerChannels(),
      before,
      "workerHandlers was drained — a later recovery would hand the worker nothing",
    );
  });
});
