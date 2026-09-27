// onNotification on the SharedWorker path: two replay bugs, and the fix for
// each pulls against the other.
//
// BUG 1 — no replay at all. Found by instrumenting a real return visit to Home
// under Playwright/CDP throttling: the context bar holds a `pco:live` (and
// obs/reaper/scores/…) subscription open for the whole life of the tab —
// `useBarContext` in context-bar.tsx never unmounts. From the shared worker's
// point of view, "which channels does this tab want" therefore never actually
// SHRANK when Home unmounted and never GREW again when Home remounted on a
// return visit, because the context bar was already holding the channel open
// the whole time. The worker's own replay (sse-shared-worker.ts's `replayTo`)
// is keyed to exactly that per-tab set — a previous-vs-wanted diff — so it
// never counted Home's new callback as "added" and sent it nothing. Home's own
// `pcoLiveKnown` stayed false until its `pco:getLive` GET answered, which on
// the measured Slow-4G profile was ~700ms after mount: no spinner, no cards,
// nothing, then a sudden repaint.
//
// The first fix in api.ts's onNotification was transport-agnostic and
// unconditional: replay from THIS PROCESS's own `lastPayload` cache to every
// new callback directly, regardless of which transport delivered the frame
// that populated it.
//
// BUG 2 — that fix is wrong exactly when the channel's local hold count just
// dropped to zero and came back. The worker only forwards a channel to this
// PORT while at least one local callback wants it (sse-shared-worker.ts's
// `fanout`, gated on the port's reported channel set) — so the moment the
// count reaches zero, THIS PROCESS's cache freezes at whatever it last was,
// while the worker's OWN cache keeps updating from the underlying
// EventSource regardless of who wants it. A subscriber joining after that
// drop got OUR frozen, stale value first (unconditional replay), then the
// worker's fresh one a tick later once its own diff-based replayTo caught up
// — wrong, then right. Affects any channel nothing else holds open
// (spl:metrics for SplCard, displays:presence for ScreensCard): navigating
// away from Home and back is exactly "drop to zero, then rejoin".
//
// The fix: only take the unconditional replay when the channel was ALREADY
// held by another local callback before this one joined — the one condition
// under which the local cache is guaranteed to have kept up. Otherwise leave
// it to the worker's own reply, which is the fresher of the two.
//
// This test drives the worker path specifically, since the direct
// (EventSource) path attaches an unconditional per-channel cache listener the
// moment the stream opens — independent of local subscriber count — so its
// cache never goes stale this way and was never either bug; see
// sse-subscribe.test.ts's own case for that path.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** A SharedWorker port a test can push frames down and inspect what a tab
 *  posted up. Nothing here runs the real sse-shared-worker.ts — this fakes
 *  the OTHER side of the channel so onNotification's worker branch runs
 *  against a controllable stand-in instead of a real worker thread. */
class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  postMessage(msg: unknown): void {
    this.sent.push(msg);
  }
  start(): void {}
  /** Simulate the worker delivering one frame to this tab, exactly as
   *  ensureWorker()'s own port.onmessage handler expects it. */
  deliver(msg: { channel: string; data: unknown; replay?: boolean }): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}
class FakeSharedWorker {
  static instances: FakeSharedWorker[] = [];
  readonly port = new FakePort();
  constructor(_url: unknown, _opts?: unknown) {
    FakeSharedWorker.instances.push(this);
  }
}
(globalThis as unknown as { SharedWorker: unknown }).SharedWorker = FakeSharedWorker;

// api.ts starts a real setInterval heartbeat the moment the (fake) worker is
// created, and exposes no seam to stop it — __sseFallback.abandon() exists for
// that, but it also calls ensureEventSource(), which opens a REAL EventSource
// against a relative URL with nothing here to stub it, hanging the process.
// Capturing every interval this file starts and clearing them all after is the
// narrower fix: it costs this file nothing about the real teardown path, which
// no test here exercises.
const startedIntervals: ReturnType<typeof setInterval>[] = [];
const realSetInterval = globalThis.setInterval.bind(globalThis);
(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((
  ...args: Parameters<typeof setInterval>
) => {
  const id = realSetInterval(...args);
  startedIntervals.push(id);
  return id;
}) as typeof setInterval;

// Evaluated with the fake already in place, so `sharedSse` (computed at module
// load from `typeof SharedWorker !== "undefined"`) takes the worker path.
const { onNotification } = await import("./api.js");

after(() => {
  for (const id of startedIntervals) clearInterval(id);
  teardown();
});

describe("onNotification on the shared-worker path", () => {
  test("a subscriber joining a channel another subscriber already held still gets the cached frame", async () => {
    const ch = "pco:live";
    const a: unknown[] = [];
    // Stands in for the context bar: subscribes once, for the life of the tab.
    const offA = onNotification(ch, (p) => a.push(p));

    const worker = FakeSharedWorker.instances.at(-1)!;
    // A live push, forwarded by the (fake) worker exactly as a real one would.
    worker.port.deliver({ channel: ch, data: { mode: "item" }, replay: false });
    assert.deepEqual(a, [{ mode: "item" }], "the first subscriber must see the live push");

    // Home mounts into a channel the tab never actually let go of. From the
    // worker's perspective the tab's wanted-channel SET does not change here —
    // "pco:live" was already in it — so its own diff-based replay has nothing
    // to send this new callback.
    const b: Array<[unknown, boolean]> = [];
    const offB = onNotification(ch, (p, replayed) => b.push([p, replayed]));
    // The replay is deferred to a microtask (never delivered synchronously
    // during the caller's own render) — flush it.
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    assert.deepEqual(
      b,
      [[{ mode: "item" }, true]],
      "a subscriber joining a channel another subscriber already held got no replay at all — " +
        "this is why Home drew nothing on a return visit until its own read answered",
    );

    offA();
    offB();
  });

  test("a channel that drops to zero local subscribers does not hand the next one a stale cache", async () => {
    const ch = "spl:metrics";
    const worker = FakeSharedWorker.instances.at(-1)!;

    const a: unknown[] = [];
    const offA = onNotification(ch, (p) => a.push(p));
    // A live push while A holds the channel — this is what warms THIS
    // PROCESS's own cache, and is the value that would go stale next.
    worker.port.deliver({ channel: ch, data: { value: 1 }, replay: false });
    assert.deepEqual(a, [{ value: 1 }]);

    // The local hold drops to zero. The worker stops forwarding this channel
    // to this port at all — nothing here can hear what happens to it next.
    offA();

    // The value changes server-side while nobody is listening — exactly what
    // the real worker's own per-port filtering does, so nothing is delivered
    // to this tab for it. This process's cache is now STALE at { value: 1 }.

    const b: Array<[unknown, boolean]> = [];
    const offB = onNotification(ch, (p, replayed) => b.push([p, replayed]));
    // Flush whatever an (incorrect) unconditional replay would have queued.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(
      b,
      [],
      "a subscriber joining right after a drop-to-zero was handed the stale cached value first — " +
        "wrong, then right, once the worker's own fresher reply catches up",
    );

    // The worker's OWN reply — the fresher one — lands moments later, exactly
    // as its per-port diff would send it once this port reports the channel
    // as newly wanted again.
    worker.port.deliver({ channel: ch, data: { value: 2 }, replay: true });
    assert.deepEqual(b, [[{ value: 2 }, true]], "and the new subscriber gets only the fresh value, once");

    offB();
  });
});
