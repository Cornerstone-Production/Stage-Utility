// The shared SSE worker's replay must be distinguishable from a live push.
//
// The bug: `replayTo()` posted `{ channel, data }` — the exact same shape
// `fanout()` posts for a genuine server push — with no `replay` field at all.
// api.ts's worker `onmessage` reads `msg.replay === true` to answer
// `onNotification`'s `replayed` argument, so every late subscriber's connect-
// time replay came through indistinguishable from a live frame. `sharedSse`
// defaults to true whenever `SharedWorker` exists (every desktop/laptop
// browser), so this is the DEFAULT transport in production — meaning every
// `replayed`-aware guard in the renderer (the update lock among them) never
// once saw `replayed === true` through it, silently.
//
// Exercises the worker module directly (not through api.ts, which only talks
// to a REAL SharedWorker's port — unavailable in Node/jsdom): fakes the two
// MessagePort halves `ctx.onconnect` touches, and a fake EventSource standing
// in for the one true upstream connection, recording every instance the
// module constructs so a test can drive it.

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
after(() => teardown());

/** Enough of EventSource for attach()/ensureEs(): a readyState, and
 *  addEventListener recording one handler per named channel so a test can
 *  fire it to simulate a genuine server push. Every instance the module
 *  constructs is recorded on the class, since the module keeps its own `es`
 *  private. */
class FakeUpstreamEventSource {
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeUpstreamEventSource[] = [];
  readyState = FakeUpstreamEventSource.OPEN;
  listeners = new Map<string, (e: { data: string }) => void>();
  constructor() {
    FakeUpstreamEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (e: { data: string }) => void): void {
    this.listeners.set(name, fn);
  }
  push(channel: string, payload: unknown): void {
    this.listeners.get(channel)?.({ data: JSON.stringify(payload) });
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeUpstreamEventSource;
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

/** One tab's half of the MessageChannel `ctx.onconnect` receives. */
function fakePort() {
  const posted: Record<string, unknown>[] = [];
  const port = {
    postMessage: (m: Record<string, unknown>) => posted.push(m),
    start: () => {},
    onmessage: null as null | ((e: { data: unknown }) => void),
  };
  return { port, posted };
}

test("a live push carries no replay flag; a late subscriber's replay does", async () => {
  await import("./sse-shared-worker.js");
  // The module sets `self.onconnect` — `self` is jsdom's window (installDom
  // exposes it as its own global, distinct from bare `globalThis`).
  const onconnect = (globalThis as unknown as { self: { onconnect: (e: { ports: unknown[] }) => void } }).self
    .onconnect;
  assert.equal(typeof onconnect, "function", "the worker must have installed onconnect");

  // Tab 1 connects and subscribes to pco:live before anything has ever been
  // pushed — nothing to replay yet.
  const tab1 = fakePort();
  onconnect({ ports: [tab1.port] });
  tab1.port.onmessage!({ data: { type: "subscribe", channels: ["pco:live"] } });
  assert.equal(tab1.posted.length, 0, "nothing cached yet, so no replay");

  assert.equal(FakeUpstreamEventSource.instances.length, 1, "ensureEs() should have constructed exactly one EventSource");
  // The upstream EventSource delivers a genuine server push — must reach tab1
  // as a live frame, with no `replay` field. The clock is pinned so the replay
  // below can be checked for WHEN the frame arrived, not just that it did.
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    FakeUpstreamEventSource.instances[0]!.push("pco:live", { mode: "item" });
  } finally {
    Date.now = realNow;
  }

  assert.equal(tab1.posted.length, 1);
  assert.equal(tab1.posted[0]!.replay, undefined, "a live push must not read as a replay");
  assert.deepEqual(tab1.posted[0], { channel: "pco:live", data: { mode: "item" } });

  // Tab 2 connects AFTER the cache is warm — a late subscriber, the exact case
  // api.ts's replay comment describes. It must be told this is a replay.
  const tab2 = fakePort();
  onconnect({ ports: [tab2.port] });
  tab2.port.onmessage!({ data: { type: "subscribe", channels: ["pco:live"] } });

  assert.equal(tab2.posted.length, 1);
  assert.equal(tab2.posted[0]!.replay, true, "a late subscriber's connect-time frame must be flagged as a replay");
  // `at` is when the cached frame arrived, which a tab needs to tell a cached
  // snapshot newer than a read it joined from an older one ("Shared reads" in
  // api.ts). It is the push's arrival, not the replay's.
  assert.deepEqual(tab2.posted[0], { channel: "pco:live", data: { mode: "item" }, replay: true, at: 1_700_000_000_000 });
});
