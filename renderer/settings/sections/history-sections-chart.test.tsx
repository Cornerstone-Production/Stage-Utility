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
  samples: Array.from({ length: 40 }, (_, i) => ({
    t: new Date(T0 - 30 * MIN + i * 3 * MIN).toISOString(),
    attendance: 100 + i * 5,
    occupancy: 200 + i,
  })),
  attendanceBaseline: 100,
  totalAttendance: 900,
  peakAttendance: 295,
  peakOccupancy: 239,
  minOccupancy: 200,
  lastAttendance: 295,
  lastOccupancy: 239,
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

function attendance() {
  return React.createElement(
    AttendanceDetail as unknown as React.FunctionComponent<Record<string, unknown>>,
    { detail: ATTENDANCE, timeline: TIMELINE },
  );
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
  assert.equal(screen.queryByText("Summary"), null);
  // The lane drew the plan's items.
  assert.equal(document.querySelectorAll("[data-lane-segment]").length, 2);
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
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ metrics: ["LAeq"] }),
  })) as unknown as typeof fetch;
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
