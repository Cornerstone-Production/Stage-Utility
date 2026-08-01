import { strict as assert } from "node:assert";
import { test } from "node:test";

/**
 * The request gate in pco-service, in isolation.
 *
 * A burst of concurrent calls is what earns a 429, and retrying does not help
 * while the burst that caused it is still in flight — so the cap is the part
 * worth pinning.
 */
class Gate {
  private inFlight = 0;
  private pending: (() => void)[] = [];
  peak = 0;

  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.inFlight++;
        this.peak = Math.max(this.peak, this.inFlight);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.inFlight--;
          this.pending.shift()?.();
        });
      };
      if (this.inFlight < this.max) grant();
      else this.pending.push(grant);
    });
  }
}

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

test("a burst never exceeds the cap", async () => {
  const g = new Gate(4);
  await Promise.all(
    Array.from({ length: 40 }, async () => {
      const release = await g.acquire();
      await tick();
      release();
    }),
  );
  assert.equal(g.peak, 4, `peaked at ${g.peak}`);
});

test("every queued caller eventually runs", async () => {
  const g = new Gate(2);
  let done = 0;
  await Promise.all(
    Array.from({ length: 25 }, async () => {
      const release = await g.acquire();
      await tick();
      done++;
      release();
    }),
  );
  assert.equal(done, 25);
});

test("a thrown request still frees its slot", async () => {
  const g = new Gate(2);
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      const release = await g.acquire();
      try {
        throw new Error("boom");
      } catch {
        /* the caller's finally is what releases */
      } finally {
        release();
      }
    }),
  );
  // If a failure leaked a slot the pool would be exhausted and this would hang.
  const release = await g.acquire();
  release();
  assert.ok(g.peak <= 2);
});

test("releasing twice cannot over-grant the pool", async () => {
  const g = new Gate(1);
  const release = await g.acquire();
  release();
  release(); // a double release must not free a second slot
  const a = await g.acquire();
  let bGranted = false;
  void g.acquire().then(() => (bGranted = true));
  await tick(5);
  assert.equal(bGranted, false, "the second caller must still be queued");
  a();
  await tick(5);
  assert.equal(bGranted, true);
  assert.ok(g.peak <= 1, `peaked at ${g.peak}`);
});

test("a slow request does not starve the queue behind it", async () => {
  const g = new Gate(2);
  const order: number[] = [];
  await Promise.all([
    (async () => {
      const r = await g.acquire();
      await tick(20);
      order.push(1);
      r();
    })(),
    (async () => {
      const r = await g.acquire();
      await tick(1);
      order.push(2);
      r();
    })(),
    (async () => {
      const r = await g.acquire();
      order.push(3);
      r();
    })(),
  ]);
  assert.equal(order.length, 3);
  assert.ok(order.indexOf(2) < order.indexOf(1), "the fast one is not blocked by the slow one");
});
