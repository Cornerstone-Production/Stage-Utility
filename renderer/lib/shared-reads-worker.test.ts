// Shared reads on the SharedWorker transport: a replay's cache time decides
// whether a joined read of a snapshot with no rev can be trusted.
//
// The worker is the DEFAULT transport in every desktop browser, and it is the
// one path the jsdom suite otherwise never runs: jsdom has no SharedWorker, so
// shared-reads.test.ts exercises the direct EventSource path only. A review
// mutated api.ts to drop the worker's `at` on the floor and the whole suite
// stayed green. These cases run api.ts's own worker branch against a fake
// worker, so the `at` the page reads off a replay is what is under test.
//
// Why `at` matters: a later mount can join a read an earlier mount sent. If
// the worker then replays a snapshot it took AFTER that read was sent, the
// joined answer is older than what the new mount has just been handed, and a
// consumer with no rev to compare would keep the older one. So api.ts reads
// again in that case, and only that case.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

/** The tab's end of the worker's port: frames can be delivered down it. */
class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  postMessage(): void {}
  start(): void {}
  deliver(msg: { channel: string; data: unknown; replay?: boolean; at?: number }): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
}
class FakeSharedWorker {
  static last: FakeSharedWorker | null = null;
  readonly port = new FakePort();
  constructor() {
    FakeSharedWorker.last = this;
  }
}
(globalThis as unknown as { SharedWorker: unknown }).SharedWorker = FakeSharedWorker;

// api.ts starts a heartbeat interval when it builds the worker, with no seam to
// stop it; cleared here so the file can exit.
const intervals: ReturnType<typeof setInterval>[] = [];
const realSetInterval = globalThis.setInterval.bind(globalThis);
(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((
  ...args: Parameters<typeof setInterval>
) => {
  const id = realSetInterval(...args);
  intervals.push(id);
  return id;
}) as typeof setInterval;

// Loaded with the fake in place, so api.ts takes the worker branch.
const { invoke, onNotification, __resetReplayCacheForTests } = await import("./api.js");

after(() => {
  for (const id of intervals) clearInterval(id);
  teardown();
});
beforeEach(() => __resetReplayCacheForTests());

/** A fetch the case answers by hand, counting reads of one path. */
function heldFetch() {
  const waiting: Array<(body: unknown) => void> = [];
  let reads = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = (input: unknown, init?: { method?: string }) => {
    if (String(input) === "/api/baptism" && (init?.method ?? "GET") === "GET") reads += 1;
    return new Promise((resolve) => {
      waiting.push((body) => resolve({ ok: true, status: 200, statusText: "OK", json: async () => body }));
    });
  };
  return {
    reads: () => reads,
    answerAll: (body: unknown) => {
      for (const w of waiting.splice(0)) w(body);
    },
  };
}

/**
 * A joined read of /api/baptism, with a worker replay landing between the
 * first mount's read and the second's. Returns how many reads went out.
 */
async function joinAcrossReplay(replay: { replay: true; at?: number }): Promise<number> {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const off = onNotification("baptism:state", () => {});
  try {
    const f = heldFetch();
    const first = invoke("baptism:get"); // sent at 1_000_000
    now += 100;
    FakeSharedWorker.last!.port.deliver({ channel: "baptism:state", data: { lane: "baptizing" }, ...replay });
    now += 100;
    const second = invoke("baptism:get"); // joins the first
    f.answerAll({ lane: "testimony" });
    await first;
    await new Promise((r) => setTimeout(r, 0));
    f.answerAll({ lane: "baptizing" }); // answers a read of its own, had one gone out
    await second;
    return f.reads();
  } finally {
    off();
    Date.now = realNow;
  }
}

describe("a worker replay's cache time and a joined read", () => {
  test("a replay the worker cached BEFORE the joined read was sent leaves the join alone", async () => {
    assert.equal(await joinAcrossReplay({ replay: true, at: 1_000_000 - 500 }), 1);
  });

  test("a replay the worker cached AFTER the joined read was sent makes the caller read again", async () => {
    assert.equal(await joinAcrossReplay({ replay: true, at: 1_000_000 + 50 }), 2);
  });

  test("a replay with no cache time (a worker from an older build) counts as now", async () => {
    // The safe direction: more reads, never an older answer kept.
    assert.equal(await joinAcrossReplay({ replay: true }), 2);
  });
});
