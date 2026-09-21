// history-chart-live.test.tsx — the chart grows while the service runs.
//
// Driven through the REAL renderer/lib/api.ts, with a fake EventSource, rather
// than by re-rendering with new props: the thing being tested is that a
// "attendance:history" broadcast reaches the line, and a props-only test would
// prove the component and skip the plumbing. Same harness as
// history-arriving.test.tsx, and for the same reason.
//
// THE GUARD THAT MATTERS is `d` updated in place. React reuses a DOM element
// only while its position and key are stable; key a path by the sample count —
// an easy and natural-looking thing to do — and every append REPLACES the
// element. That kills the draw-in animation mid-stroke, resets any CSS
// transition on the line, and on a two-hour service churns 240 SVG nodes. So
// this holds the actual DOM node across appends and asserts it is the same
// object, not merely that a path exists.
//
// NOT TESTED HERE, because jsdom cannot see it: that the draw-in actually draws
// or the pulse actually pulses. jsdom loads no stylesheet, so no @keyframes rule
// exists and getComputedStyle reports no animation whatever the class. What IS
// asserted is the structural half — the animated elements are present with
// motion allowed and ABSENT under prefers-reduced-motion — which is the half a
// stylesheet cannot fix. The motion itself was watched in a browser.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../../test-dom.js";

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
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

/** The chart maps a pointer against its own box, and jsdom's is all zeros. */
Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ left: 0, top: 0, right: 640, bottom: 217, width: 640, height: 217, x: 0, y: 0, toJSON() {} }),
});

const { act, render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { useEffect, useState } = React;
const { onNotification } = await import("../../../lib/api.js");
const { AttendanceDetail } = await import("../attendance-history-section.js");
const { HistoryChart } = await import("./history-chart.js");

const T0 = Date.parse("2026-09-17T20:00:00.000Z");
const MIN = 60_000;
const SERVICE_KEY = "salt:plan-9:time-1";

/** An OPEN record (endedAt null) with `n` samples, one a minute. */
function openRecord(n: number) {
  return {
    serviceKey: SERVICE_KEY,
    serviceTypeId: "salt",
    serviceTypeName: "The Salt Company",
    planId: "plan-9",
    planTitle: "Night of Worship",
    seriesTitle: null,
    serviceDate: "2026-09-17",
    serviceTimeId: "time-1",
    serviceTimeStartsAt: new Date(T0).toISOString(),
    startedAt: new Date(T0).toISOString(),
    serviceStartedAt: new Date(T0 + 5 * MIN).toISOString(),
    endedAt: null,
    samples: Array.from({ length: n }, (_, i) => ({
      t: new Date(T0 + i * MIN).toISOString(),
      attendance: 10 + i * 3,
      occupancy: 100 + i * 2,
    })),
    attendanceBaseline: 10,
    totalAttendance: 10 + (n - 1) * 3,
    peakAttendance: 10 + (n - 1) * 3,
    peakOccupancy: 100 + (n - 1) * 2,
    minOccupancy: 100,
    lastAttendance: 10 + (n - 1) * 3,
    lastOccupancy: 100 + (n - 1) * 2,
  };
}

const TIMELINE = {
  serviceKey: SERVICE_KEY,
  items: [
    {
      itemId: "welcome",
      title: "Welcome",
      sequence: 0,
      plannedLengthSec: 300,
      startedAt: new Date(T0 + 5 * MIN).toISOString(),
      endedAt: new Date(T0 + 10 * MIN).toISOString(),
      actualDurationSec: 300,
    },
    // Still live: no endedAt. Its block must GROW as the clock moves.
    {
      itemId: "message",
      title: "Message",
      sequence: 1,
      plannedLengthSec: 1800,
      startedAt: new Date(T0 + 10 * MIN).toISOString(),
      endedAt: null,
      actualDurationSec: null,
    },
  ],
} as unknown as ServiceTimeline;

/** The section's own subscription, in miniature: the broadcast replaces the
 *  record, the record is the chart's props. This is exactly what
 *  service-history-section.tsx does with the same channel. */
function LiveHarness({ initial }: { initial: ReturnType<typeof openRecord> }) {
  const [record, setRecord] = useState(initial);
  useEffect(
    () =>
      onNotification("attendance:history", (p) => {
        const rec = p as ServiceAttendance | null;
        if (rec && rec.serviceKey === SERVICE_KEY) setRecord(rec as unknown as ReturnType<typeof openRecord>);
      }),
    [],
  );
  return (
    <AttendanceDetail detail={record as unknown as ServiceAttendance} timeline={TIMELINE} />
  );
}

/** Push one more sample down the SSE channel, as the recorder does every 30s. */
async function appendSample(n: number) {
  await act(async () => {
    FakeEventSource.last?.push("attendance:history", openRecord(n));
    await Promise.resolve();
  });
}

function reducedMotion(on: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: on && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
}

// EVERY QUERY IS SCOPED TO THE TREE THIS TEST MOUNTED.
//
// A page-wide document.querySelector reads whatever an EARLIER test left behind
// if its container has not been torn down yet, and the failure it produces is
// backwards: "a finished record has a live edge" was the previous test's live
// chart being found. Worse, a `document.querySelector(...) === null` assertion
// hands node:assert a live jsdom element to inspect when it is wrong, which does
// not terminate — that is what SIGKILLed this file at 30 seconds.
let container: HTMLElement;
function mounted(selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}
function one(selector: string): Element | undefined {
  return mounted(selector)[0];
}

beforeEach(() => {
  localStorage.clear();
  reducedMotion(false);
});
afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

describe("a growing service", () => {
  test("appending samples updates `d` on the SAME path element", async () => {
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    const path = one("[data-series-line='occupancy']") as SVGPathElement;
    assert.ok(path, "no series line");
    const before = path.getAttribute("d");

    for (const n of [6, 7, 8, 9, 10]) await appendSample(n);

    const after = one("[data-series-line='occupancy']") as SVGPathElement;
    // Identity, not a re-query that happens to match: a replaced element would
    // satisfy `assert.ok(after)` and every `d` comparison below it.
    assert.equal(after === path, true, "the path element was replaced, not updated");
    assert.notEqual(after.getAttribute("d"), before, "`d` did not change");
    assert.equal((after.getAttribute("d") ?? "").split("L").length, 10, "not every sample reached the line");
  });

  test("exactly one line element per series, however many samples arrive", async () => {
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    for (const n of [6, 7, 8, 9, 10, 11, 12]) await appendSample(n);
    assert.equal(mounted("[data-series-line='occupancy']").length, 1);
  });

  test("the live edge is drawn, and pulses", async () => {
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    const dot = one("[data-live-edge]") as SVGCircleElement;
    assert.ok(dot, "no live edge");
    assert.equal(dot.getAttribute("class"), "su-history-pulse");
  });

  test("the newest stretch gets its own draw-in element", async () => {
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    const first = one("[data-series-draw-in='occupancy']") as SVGPathElement;
    assert.ok(first, "no draw-in stretch");
    await appendSample(6);
    const second = one("[data-series-draw-in='occupancy']") as SVGPathElement;
    // This one is SUPPOSED to be replaced — that is what replays the animation,
    // and it is why it is a separate element from the line above.
    assert.equal(second === first, false, "the draw-in stretch did not replay");
  });

  test("more samples reach further across the plot", async () => {
    // Motion off, for the reason recorded on the clock test below: this asks a
    // GEOMETRY question, and the x-domain tween leaves a requestAnimationFrame
    // chain running past the assertion. It seeds its tween in a layout effect
    // now, so the window in which an append and a tween overlap is a render
    // wider than it was, and this failed once under full-suite load.
    reducedMotion(true);
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    const lastX = () => {
      const d = one("[data-series-line='occupancy']")?.getAttribute("d") ?? "";
      return Number(d.split("L").pop()?.split(",")[0]);
    };
    const before = lastX();
    for (const n of [10, 20, 30]) await appendSample(n);
    assert.ok(lastX() > before, `the line did not extend: ${before} → ${lastX()}`);
  });

  // The live item's block is driven by the CLOCK, not by the sample stream — a
  // counter that has gone quiet must not freeze the item that is still running.
  // So this one drives the clock directly rather than through the SSE harness;
  // `nowMs` is the component's seam for exactly that.
  test("the live item's block grows with the clock, with no new samples at all", async () => {
    // Motion off for this one: it is about geometry, and the x-domain tween
    // would otherwise leave a requestAnimationFrame chain running past the
    // assertion, which in this harness wedges the file.
    reducedMotion(true);
    const points = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * MIN, v: 100 + i }));
    const items = [{
      itemId: "message",
      title: "Message",
      sequence: 1,
      startedAt: new Date(T0 + 10 * MIN).toISOString(),
      endedAt: null,
      preService: false,
      plannedSec: 1800,
      actualSec: null,
    }];
    const at = (nowMs: number) => (
      <HistoryChart
        series={[{ id: "occupancy", label: "Attendance", color: "var(--green-9)", role: "primary" as const, fill: true, points }]}
        items={items}
        window={{ startedAt: new Date(T0).toISOString(), endedAt: null }}
        yScale={{ kind: "count" as const }}
        figures={[]}
        live
        ariaLabel="live"
        nowMs={nowMs}
      />
    );
    const width = () => Number((one("[data-lane-segment='message']") as SVGRectElement).getAttribute("width"));
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(at(T0 + 25 * MIN));
      container = view.container;
    });
    const before = width();
    await act(async () => {
      view.rerender(at(T0 + 29 * MIN));
    });
    assert.ok(width() > before, `the live block did not grow: ${before} → ${width()}`);
  });

  test("the service ending takes the live edge and the draw-in away", async () => {
    // Driven as the TRANSITION, not as a record that was closed all along:
    // api.ts replays the channel's last payload to a new subscriber (the hello
    // burst does the same thing over a real connection), so a component that
    // mounted with a closed record would be handed the previous test's open one
    // a tick later anyway. Closing it over the wire is both the honest test and
    // the one that survives the replay.
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    assert.equal(mounted("[data-live-edge]").length, 1, "the open record had no live edge to lose");

    await act(async () => {
      FakeEventSource.last?.push("attendance:history", {
        ...openRecord(10),
        endedAt: new Date(T0 + 10 * MIN).toISOString(),
      });
      await Promise.resolve();
    });

    assert.equal(mounted("[data-live-edge]").length, 0);
    assert.equal(mounted("[data-series-draw-in='occupancy']").length, 0);
  });
});

describe("prefers-reduced-motion", () => {
  test("no pulse and no draw-in element at all", async () => {
    reducedMotion(true);
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    await appendSample(6);
    const dot = one("[data-live-edge]") as SVGCircleElement;
    // The edge still marks where the service is — that is information, not
    // motion. Only the animation goes.
    assert.ok(dot, "the live edge itself should stay");
    assert.equal(dot.getAttribute("class"), null, "the pulse survived reduced motion");
    assert.equal(
      mounted("[data-series-draw-in='occupancy']").length,
      0,
      "the draw-in stretch survived reduced motion",
    );
  });

  test("the line is still the same element, still growing", async () => {
    reducedMotion(true);
    await act(async () => {
      container = render(<LiveHarness initial={openRecord(5)} />).container;
    });
    const path = one("[data-series-line='occupancy']") as SVGPathElement;
    const before = path.getAttribute("d");
    await appendSample(9);
    assert.equal(one("[data-series-line='occupancy']") === path, true);
    assert.notEqual(path.getAttribute("d"), before);
  });
});
