// The read must never overwrite a newer push.
//
// Every integration status hook hydrates with a one-shot read and subscribes to
// a channel that broadcasts ONLY on change. When a push landed before the read
// resolved, the read's setState ran last and put the older value back — and
// nothing corrects it, because the next frame does not arrive until something
// else changes. On a quiet weekday that is hours of a wrong recording light.
//
// Driven through the REAL renderer/lib/api.ts, not a stub of it, over a fake
// EventSource. That matters for the second test: api.ts caches the last frame of
// a hydrated channel and replays it to every late subscriber, which is what made
// the obvious fix ("ignore the read once any push has arrived") wrong — a push
// always arrives, carrying the CONNECT-TIME value the read exists to correct. A
// stub of api.ts would not have that behaviour and the test would prove nothing.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** A fake EventSource that hands the test its channel listeners to fire. */
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

  /** Deliver a server frame on a channel, exactly as the SSE stream would. */
  push(channel: string, payload: unknown): void {
    for (const fn of this.listeners.get(channel) ?? []) {
      fn({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "{}",
});

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useStatusChannel } = await import("./use-status-channel.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  await settle();
  teardown();
});
beforeEach(() => cleanup());
afterEach(async () => {
  cleanup();
  await settle();
});

interface Dto {
  connected: boolean;
  recording: boolean;
  rev?: number;
}

/** A promise the test resolves by hand, so the read can be made to land late. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Render the hook and expose what it currently reports. */
function mount(read: () => Promise<Dto | null>, channel: string) {
  const seen: { value: Dto | null } = { value: null };
  function Probe(): React.ReactElement {
    const v = useStatusChannel<Dto>(read, channel);
    seen.value = v;
    return React.createElement("output", null, v ? String(v.recording) : "none");
  }
  render(React.createElement(Probe));
  return seen;
}

describe("useStatusChannel publish ordering", () => {
  test("a push that lands before the read resolves is not overwritten by it", async () => {
    // The bug, exactly. The server published rev 7 (recording started) while the
    // hydrate read — taken at rev 6, before it started — was still in flight.
    const read = deferred<Dto | null>();
    const seen = mount(() => read.promise, "obs:status");
    await settle();

    FakeEventSource.last!.push("obs:status", { connected: true, recording: true, rev: 7 });
    await settle();
    assert.equal(seen.value?.recording, true, "the push should have been applied");

    read.resolve({ connected: true, recording: false, rev: 6 });
    await settle();

    assert.equal(
      seen.value?.recording,
      true,
      "the older read must not put the stale value back — this channel broadcasts " +
        "only on change, so nothing would ever correct it",
    );
    assert.equal(seen.value?.rev, 7);
  });

  test("a read that is newer than the push still applies", async () => {
    // The other direction, and the case that makes an ignore-the-read flag wrong.
    const read = deferred<Dto | null>();
    const seen = mount(() => read.promise, "reaper:status");
    await settle();

    FakeEventSource.last!.push("reaper:status", { connected: true, recording: false, rev: 3 });
    await settle();

    read.resolve({ connected: true, recording: true, rev: 4 });
    await settle();

    assert.equal(seen.value?.recording, true, "a read newer than the push must win");
    assert.equal(seen.value?.rev, 4);
  });

  test("an equal rev lets the read apply — Smaart's snapshot outruns its throttle", async () => {
    // Smaart keeps `last` current between throttled broadcasts, so at the same
    // rev the read can legitimately be the fresher of the two. The rule is
    // "drop it only if STRICTLY older", not "only if strictly newer".
    const read = deferred<Dto | null>();
    const seen = mount(() => read.promise, "spl:metrics");
    await settle();

    FakeEventSource.last!.push("spl:metrics", { connected: true, recording: false, rev: 5 });
    await settle();

    read.resolve({ connected: true, recording: true, rev: 5 });
    await settle();

    assert.equal(seen.value?.recording, true, "an equal-rev read must still apply");
  });

  test("mounting into an already-open stream: the read beats the replayed hello burst", async () => {
    // The regression the naive fix would have shipped. A first subscriber makes
    // api.ts cache the connect-time frame; every later subscriber is handed that
    // cached frame in a microtask, so "a push has arrived" is true on every mount
    // and an ignore-the-read flag would pin the UI to the connect-time value for
    // as long as nothing changed.
    const { onNotification } = await import("../lib/api.js");

    // First subscriber, so the connect-time frame lands in api.ts's replay cache.
    const off = onNotification("youtube:status", () => {});
    FakeEventSource.last!.push("youtube:status", { connected: true, recording: false, rev: 2 });
    await settle();

    // Now a component mounts into that already-open stream. Its read is current
    // (rev 9); the replay it is handed is the stale connect-time rev 2.
    const read = deferred<Dto | null>();
    const seen = mount(() => read.promise, "youtube:status");
    await settle();
    assert.equal(seen.value?.rev, 2, "the replayed connect-time frame arrives first");

    read.resolve({ connected: true, recording: true, rev: 9 });
    await settle();

    assert.equal(
      seen.value?.recording,
      true,
      "the read is what corrects a stale replay — it must not be discarded merely " +
        "because a (replayed) push arrived first",
    );
    off();
  });

  test("a payload with no rev behaves exactly as before the fix", async () => {
    // An older server sends no version. The comparison is skipped rather than
    // guessed at, so the hook degrades to its previous last-writer-wins shape
    // instead of silently dropping every read.
    const read = deferred<Dto | null>();
    const seen = mount(() => read.promise, "people:count");
    await settle();

    FakeEventSource.last!.push("people:count", { connected: true, recording: true });
    await settle();

    read.resolve({ connected: true, recording: false });
    await settle();

    assert.equal(seen.value?.recording, false, "with no rev, the read applies as it always did");
  });
});
