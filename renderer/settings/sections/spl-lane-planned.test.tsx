// The SOUND chart's lane says what an item was PLANNED to run.
//
// The sound record does not carry a planned length — `SplItemHistory` is a
// title, a sequence and per-metric stats — so the section has to take it from
// the TIMELINE record beside it. It did not: it passed `plannedSec: null` for
// every segment, and the strip's PLANNED figure read "—" on the sound chart
// while the identical lane on the attendance chart filled it in.
//
// Driven through the real component and the real chart, not over a helper: the
// bug was a literal `null` at the call site, and a test over a lookup map would
// have stayed green with that literal still in place.
//
// NOT tested here, because jsdom lays nothing out: that the segment is where
// the pointer thinks it is at a real width, or that the strip's 20px value is
// 20px. Both were driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

// jsdom measures every box as 0 and the chart refuses to map a pointer against
// a zero-width box, so a hover would never register. Give it one.
const SVG_W = 640;
const SVG_H = 217;
Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { left: 0, top: 0, right: SVG_W, bottom: SVG_H, width: SVG_W, height: SVG_H, x: 0, y: 0, toJSON() {} };
  },
});

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { SplDetail } = await import("./spl-history-section.js");

const T0 = Date.parse("2026-09-17T20:15:00.000Z");
const MIN = 60_000;

/** The plan. `plannedLengthSec` lives HERE and nowhere else. */
const TIMELINE = {
  serviceKey: "1:2:3",
  items: [
    {
      itemId: "b",
      title: "Message",
      sequence: 0,
      plannedLengthSec: 1800,
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 40 * MIN).toISOString(),
      actualDurationSec: 2400,
    },
  ],
};

const SPL = {
  serviceKey: "1:2:3",
  serviceTypeId: "1",
  planId: "2",
  planTitle: "Night of Worship",
  seriesTitle: null,
  serviceDate: "2026-09-17",
  serviceTimeId: "3",
  serviceTimeStartsAt: new Date(T0).toISOString(),
  meterId: "m1",
  metricKey: "LAeq",
  startedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0 + 60 * MIN).toISOString(),
  items: [
    {
      itemId: "b",
      title: "Message",
      sequence: 0,
      metrics: { LAeq: { max: 94, avg: null, leq: 88, count: 500 } },
      maxSpl: 94,
      leqSpl: 88,
      sampleCount: 500,
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 40 * MIN).toISOString(),
    },
  ],
};

/** The 404 an old record gets, which is the per-item fallback path — the lane
 *  draws either way, and the fallback needs no series fixture. */
const splFetch = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch;

async function flushReact(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(cleanup);
after(async () => {
  cleanup();
  await flushReact();
  teardown();
});

test("hovering a sound lane segment reads the item's PLANNED length off the timeline", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = splFetch;
  try {
    render(
      React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
        detail: SPL,
        timeline: TIMELINE,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    // By its label, NOT `querySelector("svg")` — the strip's Customize trigger
    // is a lucide icon, so the first svg on the page is a glyph.
    const svg = document.querySelector("svg[role='img']") as SVGSVGElement;
    assert.ok(svg, "the sound chart did not render");
    assert.equal(document.querySelectorAll("[data-lane-segment]").length, 1, "the lane drew no segment");

    // A third across is inside the Message item (it runs the first two thirds of
    // the domain); y in the lane's service row, under the plot.
    fireEvent.pointerMove(svg, { clientX: SVG_W / 3, clientY: 205 });
    const strip = document.querySelector("[data-history-strip]") as HTMLElement;
    assert.equal(strip.dataset.historyStrip, "hover", `the lane hover did not register: ${strip.textContent}`);
    assert.ok(strip.textContent?.includes("Message"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("Planned"), strip.textContent ?? "");
    // 1800s. "—" here is the bug: a null planned length on every sound segment.
    assert.ok(strip.textContent?.includes("30:00"), `PLANNED did not fill in: ${strip.textContent}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
