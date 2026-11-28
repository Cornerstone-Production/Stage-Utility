// The two serialisers behind every "one at a time" in the server. Six hand-rolled
// copies of the promise chain were replaced by these; what each copy relied on is
// pinned here: order, the result handed back, and a rejection never wedging the
// queue behind it.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { KeyedQueue, WriteQueue } from "./write-queue.js";

/** A promise settled from outside, to hold a queue's first job open. */
function gate(): { open: () => void; wait: Promise<void> } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe("WriteQueue", () => {
  test("runs jobs one at a time, in the order queued, and hands back each result", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    const g = gate();
    const a = q.enqueue(async () => {
      log.push("a start");
      await g.wait;
      log.push("a end");
      return 1;
    });
    const b = q.enqueue(async () => {
      log.push("b start");
      return 2;
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ["a start"], "b must wait for a");
    g.open();
    assert.deepEqual(await Promise.all([a, b]), [1, 2]);
    assert.deepEqual(log, ["a start", "a end", "b start"]);
  });

  test("a job that rejects rejects its own caller, and the next job still runs once", async () => {
    const q = new WriteQueue();
    let ran = 0;
    const bad = q.enqueue(async () => {
      throw new Error("disk full");
    });
    const next = q.enqueue(async () => {
      ran += 1;
      return "ok";
    });
    await assert.rejects(bad, /disk full/);
    assert.equal(await next, "ok");
    assert.equal(ran, 1, "the job after a failure ran once, not zero and not twice");
  });
});

describe("KeyedQueue", () => {
  test("one key runs in order; two keys do not wait for each other", async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    const g = gate();
    const a1 = q.enqueue("a", async () => {
      log.push("a1 start");
      await g.wait;
      log.push("a1 end");
    });
    const a2 = q.enqueue("a", async () => {
      log.push("a2");
    });
    const b = q.enqueue("b", async () => {
      log.push("b");
    });
    await b;
    assert.deepEqual(log, ["a1 start", "b"], "b ran while a was held, and a2 waited");
    g.open();
    await Promise.all([a1, a2]);
    assert.deepEqual(log, ["a1 start", "b", "a1 end", "a2"]);
  });

  test("a rejection does not stop its key, and goes to its own caller only", async () => {
    const q = new KeyedQueue();
    const bad = q.enqueue("k", async () => {
      throw new Error("boom");
    });
    const next = q.enqueue("k", async () => 7);
    await assert.rejects(bad, /boom/);
    assert.equal(await next, 7);
  });

  test("a key's chain is dropped once it settles, so keys that come and go do not accumulate", async () => {
    const q = new KeyedQueue();
    const g = gate();
    const run = q.enqueue("venue-1", () => g.wait);
    void q.enqueue("venue-2", async () => {});
    assert.equal(q.busy, 2);
    g.open();
    await run;
    await q.idle();
    await new Promise((r) => setImmediate(r));
    assert.equal(q.busy, 0);
  });

  test("a key reused while its first job is still running keeps its chain", async () => {
    const q = new KeyedQueue();
    const g = gate();
    const g2 = gate();
    const first = q.enqueue("k", () => g.wait);
    const second = q.enqueue("k", () => g2.wait);
    g.open();
    await first;
    await new Promise((r) => setImmediate(r));
    assert.equal(q.busy, 1, "the first job's cleanup must not drop the second job's chain");
    g2.open();
    await second;
    await new Promise((r) => setImmediate(r));
    assert.equal(q.busy, 0);
  });

  test("idle waits for every key but the ones excepted", async () => {
    const q = new KeyedQueue();
    const held = gate();
    void q.enqueue("address", () => held.wait);
    let venueDone = false;
    void q.enqueue("venue", async () => {
      venueDone = true;
    });
    await q.idle(["address"]);
    assert.ok(venueDone, "idle() returned before the venue's job finished");
    held.open();
  });
});
