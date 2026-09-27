// onNotification on the SharedWorker path: replay to a subscriber joining a
// channel another subscriber already holds.
//
// The bug this guards, found by instrumenting a real return visit to Home
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
// The fix in api.ts's onNotification is transport-agnostic: it replays from
// THIS PROCESS's own `lastPayload` cache to every new callback directly,
// regardless of which transport delivered the frame that populated it. This
// test drives the worker path specifically, since the direct (EventSource)
// path already had per-callback replay and was never the bug — see
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
});
