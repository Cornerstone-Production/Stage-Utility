// onNotification on the EventSource path: the wire listener's lifetime.
//
// There was no test calling onNotification on this path at all — sse-fallback
// drives the worker bookkeeping through its own seam, and poll-transport runs
// with `?transport=poll`, where no EventSource is opened. So the claim that
// "one wire listener per channel" held was never exercised, and it did not
// hold: the listener was remembered in the closure of whichever subscriber
// happened to arrive FIRST, and removed only if that same subscriber was the
// last to leave. Mount two components on one channel, unmount them in the order
// they mounted, and the listener leaked; the next subscriber added a second
// one, and every frame from then on was delivered twice.
//
// Every display in the building is on this path.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** An EventSource that records its wiring and can deliver a frame. */
class RecordingEventSource {
  static CLOSED = 2;
  static instances: RecordingEventSource[] = [];
  readyState = 1;
  readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    RecordingEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  close() {
    this.readyState = RecordingEventSource.CLOSED;
  }
  /** How many handlers are wired for a channel right now. */
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  /** Deliver one frame, exactly as the browser would. */
  emit(type: string, payload: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }
}
(globalThis as { EventSource?: unknown }).EventSource = RecordingEventSource;

// reportChannels posts; it already swallows its own failure, but jsdom has no
// fetch and the rejection would be noise.
(globalThis as { fetch?: unknown }).fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });

// No SharedWorker in jsdom and no ?transport=poll, so this is the direct
// EventSource path — the one a display runs on.
const { onNotification } = await import("./api.js");

after(() => teardown());

/** The single stream api.ts opens. */
function stream(): RecordingEventSource {
  assert.equal(RecordingEventSource.instances.length, 1, "api.ts must open exactly one stream");
  return RecordingEventSource.instances[0];
}

// A channel that is NOT hydrated: ensureEventSource attaches its own cache
// listener to every hydrated channel, and counting those alongside the dispatch
// listener would hide the leak behind an off-by-one nobody could read.
const CH = "automation:rules";

describe("onNotification on the EventSource path", () => {
  beforeEach(() => {
    // Nothing to reset: each case uses its own channel, so a leak in one cannot
    // be laundered by a teardown in another.
  });

  test("two subscribers on a channel share one wire listener", () => {
    const off1 = onNotification(CH, () => {});
    const off2 = onNotification(CH, () => {});
    assert.equal(stream().count(CH), 1, "a listener per subscriber delivers every frame once per subscriber");
    off1();
    off2();
  });

  test("the listener survives while any subscriber remains", () => {
    const ch = "patch:updated";
    const off1 = onNotification(ch, () => {});
    const off2 = onNotification(ch, () => {});
    off1();
    assert.equal(stream().count(ch), 1, "the last subscriber must keep receiving");
    off2();
    assert.equal(stream().count(ch), 0, "and the listener goes with the last of them");
  });

  test("unsubscribing in ARRIVAL order still removes the listener", () => {
    // The bug: the listener was captured in the first subscriber's closure, so
    // the LAST to leave could only remove it if it was also the first to arrive.
    // Unmounting in mount order is the ordinary React case.
    const ch = "kiosk:devices";
    const off1 = onNotification(ch, () => {});
    const off2 = onNotification(ch, () => {});
    off1();
    off2();
    assert.equal(
      stream().count(ch),
      0,
      "the wire listener leaked — the next subscriber adds a second and every frame is handled twice",
    );
  });

  test("resubscribing after that does not double-deliver", () => {
    const ch = "cues:all";
    const offA = onNotification(ch, () => {});
    const offB = onNotification(ch, () => {});
    offA();
    offB();

    const seen: unknown[] = [];
    const offC = onNotification(ch, (p) => seen.push(p));
    assert.equal(stream().count(ch), 1, "a second wire listener means two dispatches per frame");
    stream().emit(ch, { rule: "one" });
    assert.deepEqual(seen, [{ rule: "one" }], "a component re-mounting must not render every update twice");
    offC();
  });

  test("an unsubscribed callback stops receiving while a sibling keeps it", () => {
    const ch = "osc:targets-changed";
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = onNotification(ch, (p) => a.push(p));
    const offB = onNotification(ch, (p) => b.push(p));
    offA();
    stream().emit(ch, { n: 1 });
    assert.deepEqual(a, [], "an unsubscribed handler that keeps firing is a leak and a double render");
    assert.deepEqual(b, [{ n: 1 }]);
    offB();
  });

  test("a subscriber that arrives DURING a dispatch does not get that frame", () => {
    // Why fanOut copies the callback set. A Set iterator visits an entry added
    // while it is running, so a handler that subscribes something in response to
    // a frame would have the new subscriber handed that same frame — from before
    // it existed — and then the replayed snapshot on top of it.
    //
    // Not the self-unsubscribe case, which needs no copy at all: deleting the
    // CURRENT entry of a Set mid-iteration is safe. A test written for that
    // passed with the copy removed, which is why this one is the one that ships.
    const ch = "scores:favourites-changed";
    const late: unknown[] = [];
    let offLate: null | (() => void) = null;
    const offFirst = onNotification(ch, () => {
      if (!offLate) offLate = onNotification(ch, (p) => late.push(p));
    });
    stream().emit(ch, { n: 1 });
    assert.deepEqual(late, [], "a subscriber was handed a frame from before it subscribed");
    stream().emit(ch, { n: 2 });
    assert.deepEqual(late, [{ n: 2 }], "and must still receive the next one");
    offFirst();
    if (offLate) (offLate as () => void)();
  });

  test("a hydrated channel replays its cached frame to a late subscriber", () => {
    // The replay path, on this transport rather than the polling one — the two
    // must behave identically, which is the point of the shared dispatch.
    const ch = "obs:status";
    const off1 = onNotification(ch, () => {});
    stream().emit(ch, { recording: true });
    off1();

    const seen: Array<[unknown, boolean]> = [];
    const off2 = onNotification(ch, (p, replayed) => seen.push([p, replayed]));
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        assert.deepEqual(seen, [[{ recording: true }, true]]);
        off2();
        resolve();
      });
    });
  });
});
