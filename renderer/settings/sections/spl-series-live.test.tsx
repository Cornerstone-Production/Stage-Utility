// The sound chart's raw series: switching records, refetching live, and what it
// does when the read fails rather than finding nothing.
//
// Driven through the real component with a fetch routed by URL, and — for the
// live half — through the real renderer/lib/api.ts with a fake EventSource, so
// a `spl:history` broadcast reaches the component the way the recorder's does.
// A stubbed `onNotification` would prove the component and skip the plumbing.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its message, and inspecting a live jsdom element does not
// terminate in any useful time.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  push(channel: string, payload: unknown): void {
    for (const fn of this.listeners.get(channel) ?? []) fn({ data: JSON.stringify(payload) } as MessageEvent);
  }
  /** How many listeners are attached — the unsubscribe check. */
  count(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { act, render, cleanup, screen } = await import("@testing-library/react");
const React = await import("react");
const { SplDetail } = await import("./spl-history-section.js");

const T0 = Date.parse("2026-09-17T20:15:00.000Z");
const MIN = 60_000;

function item(id: string, title: string, sequence: number) {
  return {
    itemId: id,
    title,
    sequence,
    metrics: { "LAeq 1": { max: 94, avg: null, leq: 88, count: 500 } },
    maxSpl: 94,
    leqSpl: 88,
    sampleCount: 500,
    startedAt: new Date(T0 + sequence * 10 * MIN).toISOString(),
    endedAt: new Date(T0 + (sequence + 1) * 10 * MIN).toISOString(),
  };
}

function record(key: string, { live = false, items = [item("a", "MESSAGE", 0)] } = {}) {
  return {
    serviceKey: key,
    serviceTypeId: "1",
    planId: "2",
    planTitle: "Night of Worship",
    seriesTitle: null,
    serviceDate: "2026-09-17",
    serviceTimeId: "3",
    serviceTimeStartsAt: new Date(T0).toISOString(),
    meterId: "m1",
    metricKey: "LAeq 1",
    startedAt: new Date(T0).toISOString(),
    endedAt: live ? null : new Date(T0 + 60 * MIN).toISOString(),
    items,
  } as unknown as ServiceSplHistory;
}

/**
 * Buckets whose SHAPE identifies which service they came from.
 *
 * `rising: false` is not "the same line lower down": the y axis is scaled to the
 * data, so two series at different LEVELS but the same shape project to
 * byte-identical paths, and a test comparing them passes on the bug. Proved by
 * writing it that way first.
 */
function seriesBody(rising: boolean) {
  return {
    metric: "LAeq 1",
    metrics: ["LAeq 1"],
    bucketSec: 5,
    buckets: Array.from({ length: 6 }, (_, i) => ({
      t: T0 + i * MIN,
      max: rising ? 80 + i : 90 - i * 2,
      avg: rising ? 76 + i : 86 - i * 2,
    })),
  };
}

interface Routed {
  fetch: typeof fetch;
  /** Every series request, in order. */
  asks: string[];
  /** How many of them named `key` — the per-test count. */
  asksFor: (key: string) => number;
  /** Resolve the next series request by hand. */
  hold: boolean;
  release: () => void;
}

/**
 * A fetch routed by URL. `series` decides what the series route answers:
 * a body keyed by service, a 404, or a 500.
 */
function routed(series: (key: string) => { status: number; body?: unknown }): Routed {
  const asks: string[] = [];
  let pending: (() => void)[] = [];
  const r: Routed = {
    asks,
    asksFor: (key: string) => asks.filter((k) => k === key).length,
    hold: false,
    release: () => {
      const queued = pending;
      pending = [];
      for (const f of queued) f();
    },
    fetch: (async (input: string) => {
      const url = String(input);
      if (!url.includes("/series")) return { ok: true, status: 200, json: async () => ({ metrics: [] }) };
      const key = decodeURIComponent(/history\/([^/]+)\/series/.exec(url)?.[1] ?? "");
      asks.push(key);
      const answer = series(key);
      const respond = () =>
        answer.status === 200
          ? { ok: true, status: 200, json: async () => answer.body }
          : { ok: false, status: answer.status, json: async () => ({ error: "x" }), text: async () => "x" };
      if (!r.hold) return respond();
      return new Promise((resolve) => pending.push(() => resolve(respond())));
    }) as unknown as typeof fetch,
  };
  return r;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The `d` of the raw peak line, or "" when no raw line is drawn. */
const peakPath = () =>
  (document.querySelector("[data-series-line='max']") as SVGPathElement | null)?.getAttribute("d") ?? "";

/**
 * A fresh service key per test.
 *
 * api.ts holds ONE EventSource for the module, so every mounted section in this
 * file shares it. A component an earlier test left mounted answers a later
 * test's broadcast — against the later test's fetch stub — and the later test
 * counts a read it did not cause. Distinct keys make each test's subscription
 * deaf to every other test's traffic, which is the property, not a workaround.
 */
let keyN = 0;
let KEY = "";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("spl:visibleMetrics", JSON.stringify(["LAeq 1"]));
  KEY = `svc${++keyN}:1:1`;
});
afterEach(cleanup);
after(async () => {
  cleanup();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  teardown();
});

describe("switching records", () => {
  test("the previous service's line is gone before the new one arrives", async () => {
    // The old `raw` + `noRaw` pair still read "has a series" while the new
    // record's fetch was in flight, so the PREVIOUS service's sound line sat
    // under the new service's heading — the most dangerous kind of wrong, since
    // it looks like data.
    const r = routed((key) => ({ status: 200, body: seriesBody(key === KEY) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      const view = render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: record(KEY),
        }),
      );
      await settle();
      const first = peakPath();
      assert.notEqual(first, "", "the first service drew no line");

      // The second record's answer is held, so this is exactly the in-flight
      // moment the bug lived in.
      r.hold = true;
      await act(async () => {
        view.rerender(
          React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
            detail: record("two:2:2"),
          }),
        );
      });
      assert.equal(peakPath(), "", `the previous service's line is still drawn: ${peakPath().slice(0, 40)}`);
      // And no per-item step stands in for it either.
      assert.equal(document.querySelectorAll("[data-series-line]").length, 0);
      assert.ok(screen.queryAllByText(/Reading the recorded samples/).length > 0, "no note while asking");

      r.release();
      await settle();
      const second = peakPath();
      assert.notEqual(second, "", "the second service drew no line");
      assert.notEqual(second, first, "the second service drew the first one's line");
      assert.deepEqual(r.asks, [KEY, "two:2:2"]);
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("the per-item step does not flash before the raw line", async () => {
    // `noRaw` started false, so "not asked yet" and "asked, nothing there" were
    // the same value and the step drew for a frame.
    const r = routed(() => ({ status: 200, body: seriesBody(true) }));
    r.hold = true;
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: record(KEY),
        }),
      );
      await settle();
      assert.equal(document.querySelectorAll("[data-series-line]").length, 0, "a line drew before the answer");
      r.release();
      await settle();
      assert.notEqual(peakPath(), "");
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});

describe("a read that failed rather than found nothing", () => {
  test("404 draws the per-item step", async () => {
    const r = routed(() => ({ status: 404 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: record(KEY),
        }),
      );
      await settle();
      assert.equal(document.querySelectorAll("[data-series-line='LAeq 1']").length, 1);
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("500 says the samples are unavailable, and draws NOTHING", async () => {
    // Drawing the per-item step for a failed read presents a partial answer as
    // the whole one: a flat level per item, with nothing saying the real
    // samples could not be read.
    const r = routed(() => ({ status: 500 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: record(KEY),
        }),
      );
      await settle();
      assert.equal(document.querySelectorAll("[data-series-line]").length, 0, "a chart drew for a failed read");
      assert.ok(screen.queryAllByText(/Sound samples unavailable/).length > 0, "nothing said the read failed");
      const strip = document.querySelector("[data-history-strip]") as HTMLElement;
      assert.ok(strip.textContent?.includes("Samples unavailable"), strip.textContent ?? "");
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});

describe("the live refetch", () => {
  const live = (items: ReturnType<typeof item>[]) => record(KEY, { live: true, items });

  test("an item change re-reads immediately", async () => {
    const r = routed(() => ({ status: 200, body: seriesBody(true) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: live([item("a", "MESSAGE", 0)]),
        }),
      );
      await settle();
      assert.equal(r.asksFor(KEY), 1);

      await act(async () => {
        FakeEventSource.last?.push("spl:history", live([item("a", "MESSAGE", 0), item("b", "What a God", 1)]));
      });
      await settle();
      assert.equal(r.asksFor(KEY), 2, "a new item did not re-read the series");
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a heartbeat carrying the SAME item does not re-read", async () => {
    // The recorder broadcasts every five seconds between item changes. Re-reading
    // the whole of spl.csv on each of those, per open tab, buys a third of a
    // pixel of line.
    const r = routed(() => ({ status: 200, body: seriesBody(true) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: live([item("a", "MESSAGE", 0)]),
        }),
      );
      await settle();
      assert.equal(r.asksFor(KEY), 1);

      for (let i = 0; i < 4; i++) {
        await act(async () => {
          FakeEventSource.last?.push("spl:history", live([item("a", "MESSAGE", 0)]));
        });
        await settle();
      }
      assert.equal(r.asksFor(KEY), 1, `asks=${JSON.stringify(r.asks)}`);
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a broadcast for ANOTHER service is ignored", async () => {
    const r = routed(() => ({ status: 200, body: seriesBody(true) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: live([item("a", "MESSAGE", 0)]),
        }),
      );
      await settle();
      await act(async () => {
        FakeEventSource.last?.push("spl:history", record("other:9:9", { live: true }));
      });
      await settle();
      assert.equal(r.asksFor(KEY), 1, `asks=${JSON.stringify(r.asks)}`);
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a FINISHED record does not subscribe at all", async () => {
    const r = routed(() => ({ status: 200, body: seriesBody(true) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: record(KEY),
        }),
      );
      await settle();
      await act(async () => {
        FakeEventSource.last?.push("spl:history", record(KEY, { live: true, items: [item("a", "MESSAGE", 0), item("b", "x", 1)] }));
      });
      await settle();
      assert.equal(r.asksFor(KEY), 1, "a closed record kept listening");
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("unmounting stops the refetch", async () => {
    const r = routed(() => ({ status: 200, body: seriesBody(true) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = r.fetch;
    try {
      const view = render(
        React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
          detail: live([item("a", "MESSAGE", 0)]),
        }),
      );
      await settle();
      await act(async () => {
        view.unmount();
      });
      await act(async () => {
        FakeEventSource.last?.push("spl:history", live([item("a", "MESSAGE", 0), item("b", "x", 1)]));
      });
      await settle();
      assert.equal(r.asksFor(KEY), 1, `unmounted: asks=${JSON.stringify(r.asks)}`);
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
