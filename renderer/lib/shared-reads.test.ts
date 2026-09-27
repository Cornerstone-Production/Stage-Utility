// Shared reads: a first read of a live snapshot joins an identical one on its
// way, and a Screens preview frame reads through its page's copy.
//
// Every page read the same snapshot more than once at the same moment, and
// every preview iframe on the Screens page read all of them again: 82 reads for
// 28 distinct answers on one visit to prod, /api/state (60 KB) nine times, and
// on a slow link some of them queued until they timed out. These cases pin what
// may join, what must not, and that the frame hand-off really happens.
//
// Driven through the real invoke() with a stubbed fetch. The cross-frame case
// loads a SECOND copy of api.ts whose window's parent is the first one's window,
// which is the shape a preview iframe has — so what is proved is the module's
// own start-up hand-off, not a stub of it.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installDom();
after(() => teardown());
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { invoke, onNotification, __resetReplayCacheForTests } = await import("./api.js");

/** A clock the case moves by hand, so "sent before" and "arrived after" are
 *  facts of the case rather than of how fast it ran. */
function handClock(start = 1_000_000) {
  const realNow = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    restore: () => {
      Date.now = realNow;
    },
  };
}

/** A fetch whose answers the case releases by hand, recording every call. */
function heldFetch() {
  const calls: { url: string; method: string }[] = [];
  const waiting: Array<(body: unknown) => void> = [];
  const fn = (input: unknown, init?: { method?: string }) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Promise((resolve) => {
      waiting.push((body) => resolve({ ok: true, status: 200, statusText: "OK", json: async () => body }));
    });
  };
  (globalThis as unknown as { fetch: unknown }).fetch = fn;
  return {
    calls,
    reads: (url: string) => calls.filter((c) => c.url === url && c.method === "GET").length,
    answerAll: (body: unknown) => {
      for (const w of waiting.splice(0)) w(body);
    },
  };
}

beforeEach(() => __resetReplayCacheForTests());

describe("shared snapshot reads", () => {
  test("two first reads of a live snapshot at once send one request, and each gets its own copy", async () => {
    const f = heldFetch();
    const a = invoke<{ items: number[] }>("stage:getState");
    const b = invoke<{ items: number[] }>("stage:getState");
    f.answerAll({ items: [1, 2] });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(f.reads("/api/state"), 1);
    assert.deepEqual(ra, { items: [1, 2] });
    // Separate objects: one caller changing its copy cannot reach the other's.
    ra.items.push(3);
    assert.deepEqual(rb.items, [1, 2]);
  });

  test("a read that is not a live snapshot is never joined", async () => {
    // The update lock is re-read BECAUSE something changed; joining a read sent
    // before the change would hand back the old answer.
    const f = heldFetch();
    const a = invoke("update:lock");
    const b = invoke("update:lock");
    f.answerAll({ active: false, reasons: [] });
    await Promise.all([a, b]);
    assert.equal(f.reads("/api/update/lock"), 2);
  });

  test("a write in between stops the read after it from joining one sent before it", async () => {
    const f = heldFetch();
    const before = invoke("stage:getState");
    const write = invoke("stage:setServiceType", { serviceTypeId: "41227" });
    const afterWrite = invoke("stage:getState");
    f.answerAll({});
    await Promise.all([before, write, afterWrite]);
    assert.equal(f.reads("/api/state"), 2, "the read after the write went out fresh");
  });

  test("a read after an identical one has answered sends its own", async () => {
    // Only a read still on its way is joined; a finished answer is never reused,
    // so a later read always reflects the server at the time it was asked.
    const f = heldFetch();
    const first = invoke("pco:getLive");
    f.answerAll({ mode: "item" });
    await first;
    const second = invoke<{ mode: string }>("pco:getLive");
    f.answerAll({ mode: "none" });
    assert.deepEqual(await second, { mode: "none" });
    assert.equal(f.reads("/api/pco/live"), 2);
  });

  test("a read sent more than two seconds ago is not joined", async () => {
    const f = heldFetch();
    const realNow = Date.now;
    try {
      const t0 = realNow();
      Date.now = () => t0;
      const first = invoke("pco:getLive");
      Date.now = () => t0 + 2001;
      const late = invoke("pco:getLive");
      f.answerAll(null);
      await Promise.all([first, late]);
    } finally {
      Date.now = realNow;
    }
    assert.equal(f.reads("/api/pco/live"), 2);
  });

  test("every caller of a failed shared read gets its own failure with the status", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({ error: "PCO not configured", code: "not_configured" }),
    });
    const [a, b] = await Promise.allSettled([invoke("pco:getLive"), invoke("pco:getLive")]);
    for (const r of [a, b]) {
      assert.equal(r.status, "rejected");
      const err = (r as PromiseRejectedResult).reason as { message: string; status?: number; code?: string };
      assert.equal(err.message, "PCO not configured");
      assert.equal(err.status, 503);
      assert.equal(err.code, "not_configured");
    }
    assert.notEqual((a as PromiseRejectedResult).reason, (b as PromiseRejectedResult).reason, "not one shared Error");
  });
});

describe("a joined read older than what the caller has seen", () => {
  // The review finding this pins: a snapshot with no rev is trusted by its
  // consumer because the consumer sent the read AFTER subscribing. A later mount
  // joining an earlier mount's read could apply an answer older than the frame
  // it had just been handed, and keep it until the next push.
  test("a snapshot with no rev, changed since the joined read was sent, is read again", async () => {
    const clock = handClock();
    const off = onNotification("baptism:state", () => {});
    try {
      const f = heldFetch();
      const a = invoke("baptism:get"); // sent at t0, before the change
      clock.advance(100);
      FakeEventSource.last?.push("baptism:state", { lane: "baptizing" }); // the change, live
      clock.advance(100);
      const b = invoke<{ lane: string }>("baptism:get"); // a later mount joins a's read
      f.answerAll({ lane: "testimony" }); // a's answer: from before the change
      assert.deepEqual(await a, { lane: "testimony" });
      // Let b notice, then answer the read it sends of its own.
      await new Promise((r) => setTimeout(r, 0));
      f.answerAll({ lane: "baptizing" });
      assert.deepEqual(await b, { lane: "baptizing" }, "b took the answer from before the change");
      assert.equal(f.reads("/api/baptism"), 2);
    } finally {
      off();
      clock.restore();
    }
  });

  test("a snapshot carrying a rev still joins, because its consumer orders by rev", async () => {
    const clock = handClock();
    const off = onNotification("obs:status", () => {});
    try {
      const f = heldFetch();
      const a = invoke("obs:getStatus");
      clock.advance(100);
      FakeEventSource.last?.push("obs:status", { rev: 10, recording: true });
      clock.advance(100);
      const b = invoke("obs:getStatus");
      f.answerAll({ rev: 9, recording: false });
      await Promise.all([a, b]);
      assert.equal(f.reads("/api/obs/status"), 1);
    } finally {
      off();
      clock.restore();
    }
  });

  test("content that arrived BEFORE the joined read was sent does not stop the join", async () => {
    const clock = handClock();
    const off = onNotification("baptism:state", () => {});
    try {
      FakeEventSource.last?.push("baptism:state", { lane: "testimony" }); // old news
      clock.advance(100);
      const f = heldFetch();
      const a = invoke("baptism:get"); // sent after it: at least as new
      clock.advance(100);
      const b = invoke("baptism:get");
      f.answerAll({ lane: "testimony" });
      await Promise.all([a, b]);
      assert.equal(f.reads("/api/baptism"), 1);
    } finally {
      off();
      clock.restore();
    }
  });
});

describe("a preview frame reads through its page", () => {
  test("a same-origin child's first read joins the page's read already on its way", async () => {
    const f = heldFetch();
    const page = invoke("stage:getState");

    // The child's copy of api.ts, started the way a preview iframe starts it:
    // its own module instance, in a window whose parent is the page's window.
    const pageWindow = globalThis.window;
    const childWindow = Object.create(pageWindow) as Window & Record<string, unknown>;
    Object.defineProperty(childWindow, "parent", { value: pageWindow });
    (globalThis as unknown as { window: unknown }).window = childWindow;
    let child: typeof import("./api.js");
    try {
      // The query string is what makes it a second module instance; kept in a
      // variable because the type checker cannot resolve a specifier carrying one.
      const secondCopy = "./api.js?preview-frame";
      child = (await import(secondCopy)) as typeof import("./api.js");
    } finally {
      (globalThis as unknown as { window: unknown }).window = pageWindow;
    }

    const preview = child.invoke<{ n: number }>("stage:getState");
    f.answerAll({ n: 1 });
    const [, fromPreview] = await Promise.all([page, preview]);
    assert.equal(f.reads("/api/state"), 1, "the preview did not send a read of its own");
    assert.deepEqual(fromPreview, { n: 1 });
  });
});
