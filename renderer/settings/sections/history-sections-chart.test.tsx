// The Attendance and Sound sections draw the chart module, and Customize sticks.
//
// The chip rows are gone; the same choices are behind one sliders button. The
// thing that can silently break in that swap is persistence — a popover that
// takes the click, redraws, and forgets by the next reload looks like it worked.
// So the second test unmounts and rebuilds the section from a FRESH read of the
// store, which is what a reload does.
//
// NOT asserted here, because jsdom cannot see it: that the strip's figures are
// 20px, that the separators are hairlines, that the lane labels are not clipped,
// or that the popover is positioned anywhere at all. Driven in a browser.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = await import("react");
const { AttendanceDetail } = await import("./attendance-history-section.js");
const { SplDetail } = await import("./spl-history-section.js");

const T0 = Date.parse("2026-09-17T20:15:00.000Z");
const MIN = 60_000;

const ATTENDANCE = {
  serviceKey: "1:2:3",
  serviceTypeId: "1",
  planId: "2",
  planTitle: "Night of Worship",
  seriesTitle: null,
  serviceDate: "2026-09-17",
  serviceTimeId: "3",
  serviceTimeStartsAt: new Date(T0).toISOString(),
  startedAt: new Date(T0 - 30 * MIN).toISOString(),
  serviceStartedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0 + 60 * MIN).toISOString(),
  // Ten arriving, twenty in service, ten leaving — the shape every record has.
  // The tails are near-empty and long, which is what made an all-samples average
  // read BELOW the in-service low.
  samples: [
    ...Array.from({ length: 10 }, (_, i) => ({
      t: new Date(T0 - 30 * MIN + i * 3 * MIN).toISOString(),
      attendance: 10 + i * 5,
      occupancy: 20 + i * 10,
      phase: "pre" as const,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      t: new Date(T0 + i * 2 * MIN).toISOString(),
      attendance: 100 + i * 5,
      occupancy: 200 + i,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      t: new Date(T0 + 45 * MIN + i * 3 * MIN).toISOString(),
      attendance: 300,
      occupancy: 120 - i * 10,
      phase: "post" as const,
    })),
  ],
  attendanceBaseline: 100,
  totalAttendance: 900,
  peakAttendance: 295,
  peakOccupancy: 219,
  minOccupancy: 200,
  lastAttendance: 295,
  lastOccupancy: 30,
} as unknown as ServiceAttendance;

const TIMELINE = {
  serviceKey: "1:2:3",
  items: [
    {
      itemId: "a",
      title: "Pre-roll",
      sequence: 0,
      plannedLengthSec: 900,
      startedAt: new Date(T0 - 15 * MIN).toISOString(),
      endedAt: new Date(T0).toISOString(),
      actualDurationSec: 900,
      preService: true,
    },
    {
      itemId: "b",
      title: "Message",
      sequence: 1,
      plannedLengthSec: 1800,
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 40 * MIN).toISOString(),
      actualDurationSec: 2400,
    },
  ],
} as unknown as ServiceTimeline;

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
      metrics: { LAeq: { max: 94, avg: null, leq: 88, count: 500 }, LCeq: { max: 101, avg: null, leq: 96, count: 500 } },
      maxSpl: 94,
      leqSpl: 88,
      sampleCount: 500,
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 40 * MIN).toISOString(),
    },
  ],
} as unknown as ServiceSplHistory;

/** Two items that OVERLAP — the Doors / 10 min Warning shape the repair record
 *  carries, where a reopened item's window runs back over the one before it. A
 *  globally sorted edge list walks back and forth across the overlap and draws
 *  a W through it. */
const SPL_TWO_ITEMS = {
  ...SPL,
  items: [
    {
      itemId: "doors",
      title: "Doors",
      sequence: 0,
      metrics: { LAeq: { max: 87, avg: null, leq: 77, count: 100 } },
      maxSpl: 87,
      leqSpl: 77,
      sampleCount: 100,
      startedAt: new Date(T0 - 25 * MIN).toISOString(),
      endedAt: new Date(T0 + 5 * MIN).toISOString(),
    },
    {
      itemId: "warning",
      title: "10 min Warning",
      sequence: 1,
      metrics: { LAeq: { max: 79, avg: null, leq: 78, count: 60 } },
      maxSpl: 79,
      leqSpl: 78,
      sampleCount: 60,
      // Starts BEFORE the item above it ended.
      startedAt: new Date(T0 - 10 * MIN).toISOString(),
      endedAt: new Date(T0 + 1 * MIN).toISOString(),
    },
  ],
} as unknown as ServiceSplHistory;


function attendance() {
  return React.createElement(
    AttendanceDetail as unknown as React.FunctionComponent<Record<string, unknown>>,
    { detail: ATTENDANCE, timeline: TIMELINE },
  );
}

/**
 * A fetch that answers the two routes the sound section calls, by URL.
 *
 * Routed, not a catch-all: one shape for every request handed the SERIES route
 * the visible-metrics body, and a section reading `.buckets` off it threw. A
 * stub that answers everything the same way tests the stub.
 *
 * `series: false` is the 404 an old record gets — the per-item fallback path.
 */
function splFetch({ series }: { series: boolean }): typeof fetch {
  return (async (input: string) => {
    const url = String(input);
    if (url.includes("/series")) {
      if (!series) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          metric: "LAeq",
          metrics: ["LAeq", "LCeq"],
          bucketSec: 5,
          // Twelve buckets across the Message item, climbing, with max above avg.
          buckets: Array.from({ length: 12 }, (_, i) => ({
            t: T0 + i * 3 * MIN,
            max: 88 + i,
            avg: 82 + i,
          })),
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ metrics: ["LAeq"] }) };
  }) as unknown as typeof fetch;
}

/** React's scheduler queues with setImmediate; a Radix popover's teardown lands
 *  there. Drain it or a closed popover settles after this file's DOM has gone. */
async function flushReact(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);
after(async () => {
  cleanup();
  await flushReact();
  teardown();
});

test("the attendance section is the chart module, not a chip row", () => {
  render(attendance());
  assert.ok(screen.getByLabelText(/Attendance and in-room occupancy/), "no chart");
  assert.ok(screen.getByLabelText("Customize attendance"), "no Customize control");
  // The chip rows' group captions are gone from the page body.
  assert.equal(screen.queryAllByText("Summary").length, 0);
  // The lane drew the plan's items.
  assert.equal(document.querySelectorAll("[data-lane-segment]").length, 2);
});

test("the average is the SERVICE's average, not the whole recording's", () => {
  // Peak and Lowest have always been in-service. Averaging the arrival ramp and
  // the emptying-room taper in put Average BELOW Lowest on a real record —
  // peak 1,196, lowest 933, "average" 781 — which reads as a broken figure.
  render(attendance());
  // Read the figures from the DOM, not from innerText: jsdom does not implement
  // innerText's layout-aware line breaking, so labels and values run together
  // into one string and every regex over it is a guess.
  const strip = document.querySelector("[data-history-strip]") as HTMLElement;
  const figure = (label: string) => {
    for (const cell of strip.querySelectorAll(":scope > div")) {
      const spans = cell.querySelectorAll("span");
      if (spans[0]?.textContent === label) return Number((spans[1]?.textContent ?? "").replace(/,/g, ""));
    }
    return NaN;
  };
  const avg = figure("Average");
  // The twenty in-service samples run 200…219.
  assert.equal(avg, 210, `average was ${avg}`);
  assert.ok(avg >= figure("Lowest"), `average ${avg} is below the lowest ${figure("Lowest")}`);
  assert.ok(avg <= figure("Peak"), `average ${avg} is above the peak ${figure("Peak")}`);
});

test("the at-rest strip shows the default figures", () => {
  render(attendance());
  const strip = document.querySelector("[data-history-strip]") as HTMLElement;
  for (const label of ["Peak", "Lowest", "Average", "Samples"]) {
    assert.ok(strip.textContent?.includes(label), `${label} missing from the strip`);
  }
});

test("unticking a figure in Customize survives a reload", async () => {
  const first = render(attendance());
  assert.ok(
    (document.querySelector("[data-history-strip]") as HTMLElement).textContent?.includes("Samples"),
  );

  fireEvent.click(screen.getByLabelText("Customize attendance"));
  const popover = within(screen.getByLabelText("Customize attendance", { selector: "[role='dialog']" }));
  fireEvent.click(popover.getByText("Samples"));
  await act(async () => {
    await Promise.resolve();
  });
  first.unmount();
  await flushReact();

  // A fresh mount, reading the store again — this is the reload.
  render(attendance());
  const strip = document.querySelector("[data-history-strip]") as HTMLElement;
  assert.ok(!strip.textContent?.includes("Samples"), `Samples came back: ${strip.textContent}`);
  assert.ok(strip.textContent?.includes("Peak"), "the other figures were lost too");
});

test("the sound section draws the chart and offers its Smaart metrics in Customize", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = splFetch({ series: false });
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

    assert.ok(screen.getByLabelText(/Recorded sound level per plan item/), "no chart");
    // The per-item table is KEPT — it carries Max and Leq per metric, which the
    // line does not, and nothing in this change replaces it.
    assert.ok(screen.getByRole("table"), "the per-item table went missing");
    // The peak mark the spec asks for, on the item's lane block.
    assert.equal(document.querySelectorAll("[data-peak-mark]").length, 1);

    fireEvent.click(screen.getByLabelText("Customize sound"));
    const popover = within(screen.getByLabelText("Customize sound", { selector: "[role='dialog']" }));
    assert.ok(popover.getByText("Smaart metrics"), "no Smaart metrics group");
    assert.ok(popover.getByText("LCeq"), "a recorded metric is missing from the picker");
    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the sound chart plots the real sample series when the route has one", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = splFetch({ series: true });
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
    await act(async () => {
      await Promise.resolve();
    });

    // Bucket max as the primary with its gradient, bucket avg as the dashed
    // secondary — NOT the per-item step, which draws one run per item.
    const max = document.querySelector("[data-series-line='max']") as SVGPathElement;
    const avg = document.querySelector("[data-series-line='avg']") as SVGPathElement;
    assert.ok(max, "no peak line");
    assert.ok(avg, "no average line");
    assert.equal(max.getAttribute("stroke-width"), "1.8");
    assert.equal(avg.getAttribute("stroke-dasharray"), "4 3");
    assert.equal(document.querySelectorAll("[data-series-area='max']").length, 1, "the peak line has no gradient");
    // Twelve buckets, one continuous run: the line does not break through the item.
    assert.equal(document.querySelectorAll("[data-series-line='max']").length, 1);
    assert.equal((max.getAttribute("d") ?? "").split("L").length, 12);
    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 404 falls back to the per-item step, one run per item", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = splFetch({ series: false });
  try {
    render(
      React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
        detail: SPL_TWO_ITEMS,
        timeline: TIMELINE,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(document.querySelectorAll("[data-series-line='max']").length, 0, "the raw line drew on a 404");
    // TWO runs for two items, not one line walking between them: one item's
    // level is not a slope into the next one's, and items that OVERLAP drew a W.
    assert.equal(document.querySelectorAll("[data-series-line='LAeq']").length, 2);
    // And NO gradient on the fallback. The raw line gets one (it is a real
    // curve); a step to the axis floor of a dB scale would say only where the
    // axis happens to start.
    assert.equal(document.querySelectorAll("[data-series-area]").length, 0);
    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the legend toggles a series, both ways, in step with Customize", async () => {
  const first = render(attendance());
  const legendOf = (id: string) => document.querySelector(`[data-series-toggle='${id}']`) as HTMLButtonElement;

  assert.equal(legendOf("attendance").getAttribute("aria-pressed"), "false", "Total entries starts off");
  assert.equal(document.querySelectorAll("[data-series-line='attendance']").length, 0);

  // ON from the legend.
  fireEvent.click(legendOf("attendance"));
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(legendOf("attendance").getAttribute("aria-pressed"), "true");
  assert.ok(document.querySelectorAll("[data-series-line='attendance']").length > 0, "the line did not draw");
  // And Customize agrees, because it is the same store.
  fireEvent.click(screen.getByLabelText("Customize attendance"));
  const popover = within(screen.getByLabelText("Customize attendance", { selector: "[role='dialog']" }));
  const row = popover.getByText("Total entries").closest("label") as HTMLElement;
  assert.equal(row.querySelector("[role=checkbox]")?.getAttribute("aria-checked"), "true");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await act(async () => {
    await Promise.resolve();
  });

  // OFF again from the legend.
  fireEvent.click(legendOf("attendance"));
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(legendOf("attendance").getAttribute("aria-pressed"), "false");
  assert.equal(document.querySelectorAll("[data-series-line='attendance']").length, 0);

  first.unmount();
  await flushReact();
});

test("a record that is only arriving has no average at all", async () => {
  // Peak reads 0 and Lowest reads "—" for a record with no in-service samples;
  // an Average taken off the arrival ramp was the one figure claiming a service
  // had happened. This is the "arriving" row History shows up to an hour before
  // the start.
  // Closed, not live: a LIVE record puts the strip in its LIVE state, which
  // shows the current values rather than the at-rest figures. This is the other
  // half of the same case — a record that closed having never gone live.
  const arriving = {
    ...ATTENDANCE,
    serviceStartedAt: null,
    peakOccupancy: 0,
    minOccupancy: null,
    samples: (ATTENDANCE as unknown as { samples: { phase?: string }[] }).samples.filter((s) => s.phase === "pre"),
  } as unknown as ServiceAttendance;
  render(
    React.createElement(AttendanceDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
      detail: arriving,
      timeline: null,
    }),
  );
  const strip = document.querySelector("[data-history-strip]") as HTMLElement;
  const cells = [...strip.querySelectorAll(":scope > div")].map((c) => {
    const spans = c.querySelectorAll("span");
    return [spans[0]?.textContent, spans[1]?.textContent];
  });
  const average = cells.find(([label]) => label === "Average");
  assert.ok(average, `no Average figure: ${JSON.stringify(cells)}`);
  assert.equal(average?.[1], "—", `Average read ${average?.[1]}`);
  cleanup();
  await flushReact();
});

test("the SOUND chart hatches its ramp and taper, from the window attendance uses", async () => {
  // It never did. Sound passed the SPL RECORDING's start as the service start,
  // and SPL recording begins at the first plan item — usually "Doors" — so the
  // window began exactly where the chart began and no band could draw. The two
  // charts sit one above the other on the same x scale; a band on one and not
  // the other reads as a difference in the data.
  const realFetch = globalThis.fetch;
  globalThis.fetch = splFetch({ series: false });
  try {
    render(
      React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
        detail: SPL_TWO_ITEMS,
        timeline: {
          items: [
            {
              itemId: "doors",
              title: "Doors",
              sequence: 0,
              startedAt: new Date(T0 - 25 * MIN).toISOString(),
              endedAt: new Date(T0 + 5 * MIN).toISOString(),
              preService: true,
            },
            {
              itemId: "warning",
              title: "10 min Warning",
              sequence: 1,
              startedAt: new Date(T0 - 10 * MIN).toISOString(),
              endedAt: new Date(T0 + 1 * MIN).toISOString(),
              preService: false,
            },
          ],
        },
        attendance: { serviceStartedAt: null, endedAt: new Date(T0 + 1 * MIN).toISOString() },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(document.querySelectorAll("[data-hatch='pre']").length, 1, "no pre-service hatch on sound");
    assert.equal(document.querySelectorAll("[data-hatch='post']").length, 1, "no post-service hatch on sound");
    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the SOUND chart hatches its ramp and taper, from the window attendance uses", async () => {
  // It never did. Sound passed the SPL RECORDING's start as the service start,
  // and SPL recording begins at the first plan item — usually "Doors" — so the
  // window began exactly where the chart began and no band could draw. The two
  // charts sit one above the other on the same x scale; a band on one and not
  // the other reads as a difference in the data.
  const realFetch = globalThis.fetch;
  globalThis.fetch = splFetch({ series: false });
  try {
    render(
      React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
        detail: SPL_TWO_ITEMS,
        timeline: {
          items: [
            {
              itemId: "doors",
              title: "Doors",
              sequence: 0,
              startedAt: new Date(T0 - 25 * MIN).toISOString(),
              endedAt: new Date(T0 + 5 * MIN).toISOString(),
              preService: true,
            },
            {
              itemId: "warning",
              title: "10 min Warning",
              sequence: 1,
              startedAt: new Date(T0 - 10 * MIN).toISOString(),
              endedAt: new Date(T0 + 1 * MIN).toISOString(),
              preService: false,
            },
          ],
        },
        attendance: { serviceStartedAt: null, endedAt: new Date(T0 + 1 * MIN).toISOString() },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(document.querySelectorAll("[data-hatch='pre']").length, 1, "no pre-service hatch on sound");
    assert.equal(document.querySelectorAll("[data-hatch='post']").length, 1, "no post-service hatch on sound");
    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});
