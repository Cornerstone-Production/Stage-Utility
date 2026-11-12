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

import { ChannelReports } from "../../main/services/channel-reports.js";
import { heldFetch } from "../test-held-fetch.js";

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
  close(): void {
    this.readyState = FakeUpstreamEventSource.CLOSED;
  }
  push(channel: string, payload: unknown): void {
    this.listeners.get(channel)?.({ data: JSON.stringify(payload) });
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeUpstreamEventSource;
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

/** One tab's half of the MessageChannel `ctx.onconnect` receives. */
function fakePort() {
  // Channel frames only; the stream's own up/down notes are `all`, read by the
  // test that is about them.
  const posted: Record<string, unknown>[] = [];
  const all: Record<string, unknown>[] = [];
  const port = {
    postMessage: (m: Record<string, unknown>) => {
      all.push(m);
      if (m.type !== "stream") posted.push(m);
    },
    start: () => {},
    onmessage: null as null | ((e: { data: unknown }) => void),
  };
  return { port, posted, all };
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

// The subscribe report. The server overwrites a client's filter with whichever
// report it handles LAST, and parallel POSTs are handled in no fixed order, so a
// stale report landing last used to drop a channel added after it. The held-fetch
// stub lets this test choose the order: it releases the newest request first and
// feeds each released body into a real ChannelReports, as the server route does.
test("a late-landing stale subscribe report cannot undo a newer one", async () => {
  const held = heldFetch();
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = held.fetch;
  try {
    const onconnect = (globalThis as unknown as { self: { onconnect: (e: { ports: unknown[] }) => void } }).self
      .onconnect;
    const tab = fakePort();
    onconnect({ ports: [tab.port] });
    tab.port.onmessage!({ data: { type: "subscribe", channels: ["a"] } });
    tab.port.onmessage!({ data: { type: "subscribe", channels: ["a", "b"] } });

    const reports = new ChannelReports();
    let cid = "";
    while (held.outstanding.length > 0) {
      assert.ok(held.maxConcurrent <= 1, `${held.maxConcurrent} subscribe reports were in flight at once`);
      const req = held.outstanding[held.outstanding.length - 1]!; // newest first
      const body = JSON.parse(req.body) as { cid: string; channels: string[] };
      cid = body.cid;
      reports.report(body.cid, body.channels);
      req.respond();
      await held.settle();
    }
    assert.ok(held.sent.length >= 1, "no report was sent");
    assert.ok(held.maxConcurrent <= 1, `${held.maxConcurrent} subscribe reports were in flight at once`);
    assert.ok(reports.get(cid)?.has("b"), `the filter lost b: ${JSON.stringify([...(reports.get(cid) ?? [])])}`);
  } finally {
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  }
});

test("a failed subscribe report still lets the trailing one go", async () => {
  const held = heldFetch();
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a);
  (globalThis as unknown as { fetch: unknown }).fetch = held.fetch;
  try {
    const onconnect = (globalThis as unknown as { self: { onconnect: (e: { ports: unknown[] }) => void } }).self
      .onconnect;
    const tab = fakePort();
    onconnect({ ports: [tab.port] });
    tab.port.onmessage!({ data: { type: "subscribe", channels: ["c"] } });
    tab.port.onmessage!({ data: { type: "subscribe", channels: ["c", "d"] } });
    assert.equal(held.outstanding.length, 1);
    held.outstanding[0]!.fail(new Error("network down"));
    await held.settle();
    assert.equal(held.outstanding.length, 1, "the trailing report did not go after a failure");
    assert.ok((JSON.parse(held.outstanding[0]!.body) as { channels: string[] }).channels.includes("d"));
    assert.equal(warnings.length, 1, "a failed report must be said, not swallowed");
    held.outstanding[0]!.respond();
    await held.settle();
  } finally {
    console.warn = realWarn;
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  }
});

// One report in flight at a time: a request that never settles would hold every
// later report back, so the worker's own fetch must carry a timeout. (api.ts's
// `post` has its own.) The 15 s abort itself is the platform's; what this pins is
// that the worker hands one over.
test("the worker's subscribe report can time out", async () => {
  const held = heldFetch();
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = held.fetch;
  try {
    const onconnect = (globalThis as unknown as { self: { onconnect: (e: { ports: unknown[] }) => void } }).self
      .onconnect;
    const tab = fakePort();
    onconnect({ ports: [tab.port] });
    tab.port.onmessage!({ data: { type: "subscribe", channels: ["e"] } });
    assert.equal(held.outstanding.length, 1);
    assert.ok(held.outstanding[0]!.signal instanceof AbortSignal, "a report with no timeout can hold back every later one");
    held.outstanding[0]!.respond();
    await held.settle();
  } finally {
    (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  }
});

// Whether the shared stream is delivering, told to every tab: a Screens-card
// preview draws *Not live* from it, so a frozen frame does not pass for live
// (preview-messages.ts). Each tab hears the state as it connects and on every
// change, and a stream that goes quiet past SSE_SILENCE_MS is not delivering.
test("every tab hears the shared stream open, go quiet, come back and drop, a new tab hears where it stands, and a stall is reopened once", async (t) => {
  const { SSE_HEARTBEAT_EVENT, SSE_SILENCE_MS } = await import("../../main/types/sse.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const onconnect = (globalThis as unknown as { self: { onconnect: (e: { ports: unknown[] }) => void } }).self
    .onconnect;
  const es = FakeUpstreamEventSource.instances.at(-1) as unknown as {
    onopen: () => void;
    onerror: () => void;
    listeners: Map<string, (e: { data: string }) => void>;
  };
  const beat = () => es.listeners.get(SSE_HEARTBEAT_EVENT)?.({ data: "{}" });
  const streamMessages = (posted: Record<string, unknown>[]) => posted.filter((m) => m.type === "stream");
  const a = fakePort();
  onconnect({ ports: [a.port] });
  es.onerror();
  es.onopen();
  assert.deepEqual(streamMessages(a.all).at(-1), { type: "stream", delivering: true }, "the stream opened and the tab was not told");

  // Quiet, but the heartbeat keeps it delivering.
  t.mock.timers.tick(SSE_SILENCE_MS - 1);
  beat();
  t.mock.timers.tick(SSE_SILENCE_MS - 1);
  assert.deepEqual(streamMessages(a.all).at(-1), { type: "stream", delivering: true }, "a heartbeat did not re-arm the silence deadline");
  // Then nothing at all, the heartbeat included: a frozen server.
  t.mock.timers.tick(1);
  assert.deepEqual(streamMessages(a.all).at(-1), { type: "stream", delivering: false }, "a silent stream still read as delivering");
  beat();
  assert.deepEqual(streamMessages(a.all).at(-1), { type: "stream", delivering: true }, "a heartbeat after the silence did not bring it back");

  es.onerror();
  assert.deepEqual(streamMessages(a.all).at(-1), { type: "stream", delivering: false }, "the stream dropped and the tab was not told");
  const b = fakePort();
  onconnect({ ports: [b.port] });
  assert.deepEqual(streamMessages(b.all), [{ type: "stream", delivering: false }], "a tab joining a dropped stream was not told");
  es.onopen();
  assert.deepEqual(streamMessages(b.all).at(-1), { type: "stream", delivering: true });

  // A connection that dies without a reset never errors, so the deadline also
  // reopens it: once per stall, never on a timer of its own.
  const before = FakeUpstreamEventSource.instances.length;
  const stalled = FakeUpstreamEventSource.instances.at(-1) as unknown as typeof es & { readyState: number };
  stalled.onopen();
  t.mock.timers.tick(SSE_SILENCE_MS);
  assert.equal(stalled.readyState, FakeUpstreamEventSource.CLOSED, "the silent stream was left open");
  assert.equal(FakeUpstreamEventSource.instances.length, before + 1, "the silent stream was not replaced");
  // The replacement never opens: the server is unreachable.
  t.mock.timers.tick(SSE_SILENCE_MS * 3);
  assert.equal(FakeUpstreamEventSource.instances.length, before + 1, "a stream that never opened was reopened again and again");
  const fresh = FakeUpstreamEventSource.instances.at(-1) as unknown as typeof es;
  fresh.onopen();
  fresh.listeners.get(SSE_HEARTBEAT_EVENT)?.({ data: "{}" });
  t.mock.timers.tick(SSE_SILENCE_MS);
  assert.equal(FakeUpstreamEventSource.instances.length, before + 2, "a second stall was not reopened");
});
