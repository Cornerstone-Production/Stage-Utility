import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { pcoService } from "./pco-service.js";
import { sleep } from "./fixtures/within.js";

/**
 * The request gate in pco-service, driven through the real service.
 *
 * A burst of concurrent calls is what earns a 429, and retrying does not help
 * while the burst that caused it is still in flight — so the cap is the part
 * worth pinning. This file used to test a hand-written copy of the gate, which
 * could not fail when pco-service's own gate regressed.
 */
type Gate = {
  acquireSlot(): Promise<() => void>;
  inFlight: number;
  pending: unknown[];
};
const gate = pcoService as unknown as Gate;
/** MAX_CONCURRENT in pco-service.ts, while Planning Center is not tight. */
const CAP = 4;

let peak = 0;
async function acquire(): Promise<() => void> {
  const release = await gate.acquireSlot();
  peak = Math.max(peak, gate.inFlight);
  return release;
}

afterEach(() => {
  assert.equal(gate.inFlight, 0, "a test left a slot held");
  assert.equal(gate.pending.length, 0, "a test left a waiter queued");
  peak = 0;
});

test("a burst never exceeds the cap", { timeout: 5000 }, async () => {
  await Promise.all(
    Array.from({ length: 40 }, async () => {
      const release = await acquire();
      await sleep(1);
      release();
    }),
  );
  assert.equal(peak, CAP, `peaked at ${peak}`);
});

test("every queued caller eventually runs", { timeout: 5000 }, async () => {
  let done = 0;
  await Promise.all(
    Array.from({ length: 25 }, async () => {
      const release = await acquire();
      await sleep(1);
      done++;
      release();
    }),
  );
  assert.equal(done, 25);
});

test("a thrown request still frees its slot", { timeout: 5000 }, async () => {
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      const release = await acquire();
      try {
        throw new Error("boom");
      } catch {
        /* the caller's finally is what releases */
      } finally {
        release();
      }
    }),
  );
  const release = await acquire();
  release();
  assert.ok(peak <= CAP);
});

test("releasing twice cannot over-grant the pool", { timeout: 5000 }, async () => {
  const held = await Promise.all(Array.from({ length: CAP }, () => acquire()));
  const first = held[0]!;
  first();
  first(); // a double release must not free a second slot
  const refill = await acquire(); // takes the one slot that is really free
  let granted = false;
  const waiting = acquire().then((r) => {
    granted = true;
    return r;
  });
  await sleep(5);
  assert.equal(granted, false, "the extra caller must still be queued");
  assert.equal(gate.inFlight, CAP);
  refill();
  const extra = await waiting;
  assert.equal(granted, true);
  extra();
  for (const r of held.slice(1)) r();
  assert.ok(peak <= CAP, `peaked at ${peak}`);
});

test("a slow request does not starve the queue behind it", { timeout: 5000 }, async () => {
  const order: number[] = [];
  await Promise.all([
    (async () => {
      const r = await acquire();
      await sleep(20);
      order.push(1);
      r();
    })(),
    (async () => {
      const r = await acquire();
      await sleep(1);
      order.push(2);
      r();
    })(),
    (async () => {
      const r = await acquire();
      order.push(3);
      r();
    })(),
  ]);
  assert.equal(order.length, 3);
  assert.ok(order.indexOf(2) < order.indexOf(1), "the fast one is not blocked by the slow one");
});
