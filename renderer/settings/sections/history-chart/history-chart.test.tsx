// history-chart.test.tsx — what the chart RENDERS and what the strip SAYS.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TEST, and why. jsdom loads no stylesheet
// and lays nothing out: every box is 0x0, offsetHeight and offsetWidth are 0,
// getComputedStyle answers the initial value for everything, and no @keyframes
// rule exists. So nothing here can see:
//
//   · the 45° hatch actually rendering (only that the rect exists and points at
//     the pattern) — a hatch on the wrong rect looks identical from here
//   · the 20px stat value, the 11px mono axis text or the hairline separators
//   · the draw-in and pulse animations running, or being collapsed by
//     prefers-reduced-motion (only that the animated element is or is not there)
//   · the lane label rule against REAL text metrics — jsdom has no canvas 2d
//     context, so the measurer falls back to its estimate. The rule itself is
//     tested as arithmetic, with a deterministic measurer, in lane.test.ts.
//
// All of those were driven in a headless browser against a real imported record
// at 1280 and 600 wide; see the PR for the screenshots.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's getBoundingClientRect is all zeros, and the chart REFUSES to map a
// pointer against a zero-width box (that maps every x to NaN and the crosshair
// lands at 0). Give the elements a box so a pointer move means something.
const SVG_W = 640;
const SVG_H = 217;
Object.defineProperty(Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { left: 0, top: 0, right: SVG_W, bottom: SVG_H, width: SVG_W, height: SVG_H, x: 0, y: 0, toJSON() {} };
  },
});

const { fireEvent, render, screen, cleanup } = await import("@testing-library/react");
const { HistoryChart } = await import("./history-chart.js");
const { CustomizePopover } = await import("./customize.js");
import type { ChartSeries } from "./geometry.js";
import type { LaneItem } from "./lane.js";

/** Radix's popover settles on React's scheduler, which queues with
 *  `setImmediate`. Without draining it a closed popover's callback runs after
 *  this file's DOM has gone and the FILE fails while every test in it passes —
 *  the same hop number-input.test.tsx settled on, and for the same reason. */
async function flushReact(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => cleanup());
after(async () => {
  cleanup();
  await flushReact();
  teardown();
});

const T0 = Date.parse("2026-09-17T20:00:00.000Z");
const MIN = 60_000;

function series(over: Partial<ChartSeries> = {}): ChartSeries {
  return {
    id: "occupancy",
    label: "Attendance",
    color: "var(--green-9)",
    role: "primary",
    fill: true,
    points: Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v: 100 + i })),
    ...over,
  };
}

const ITEMS: LaneItem[] = [
  {
    itemId: "pre1",
    title: "Pre-roll",
    sequence: 0,
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 15 * MIN).toISOString(),
    preService: true,
    plannedSec: 900,
    actualSec: 900,
  },
  {
    itemId: "welcome",
    title: "Welcome",
    sequence: 1,
    startedAt: new Date(T0 + 15 * MIN).toISOString(),
    endedAt: new Date(T0 + 30 * MIN).toISOString(),
    preService: false,
    plannedSec: 600,
    actualSec: 900,
  },
  {
    itemId: "message",
    title: "Message",
    sequence: 2,
    startedAt: new Date(T0 + 30 * MIN).toISOString(),
    endedAt: new Date(T0 + 60 * MIN).toISOString(),
    preService: false,
    plannedSec: 1800,
    actualSec: 1800,
  },
];

const FIGURES = [
  { key: "peak", label: "Peak", value: "160" },
  { key: "lowest", label: "Lowest", value: "100" },
  { key: "samples", label: "Samples", value: "61" },
];

function chart(props: Partial<React.ComponentProps<typeof HistoryChart>> = {}) {
  return (
    <HistoryChart
      series={[series()]}
      items={ITEMS}
      window={{ startedAt: new Date(T0 + 15 * MIN).toISOString(), endedAt: new Date(T0 + 50 * MIN).toISOString() }}
      yScale={{ kind: "count" }}
      figures={FIGURES}
      ariaLabel="Attendance over the service"
      nowMs={T0 + 60 * MIN}
      {...props}
    />
  );
}

describe("the stat strip", () => {
  test("at rest it shows the chosen figures, and only those", () => {
    render(chart());
    const strip = document.querySelector("[data-history-strip]") as HTMLElement;
    assert.equal(strip.dataset.historyStrip, "rest");
    for (const f of FIGURES) assert.ok(strip.textContent?.includes(f.label), `${f.label} missing`);
    assert.ok(!strip.textContent?.includes("Live"));
  });

  test("a figure the operator unticked is not in the strip", () => {
    render(chart({ figures: FIGURES.filter((f) => f.key !== "samples") }));
    const strip = document.querySelector("[data-history-strip]") as HTMLElement;
    assert.ok(!strip.textContent?.includes("Samples"));
    assert.ok(strip.textContent?.includes("Peak"));
  });

  test("hovering the plot swaps it for the time and the series' value there", () => {
    render(chart());
    const svg = document.querySelector("svg") as SVGSVGElement;
    fireEvent.pointerMove(svg, { clientX: SVG_W / 2, clientY: 80 });
    const strip = document.querySelector("[data-history-strip]") as HTMLElement;
    assert.equal(strip.dataset.historyStrip, "hover");
    assert.ok(strip.textContent?.includes("Time"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("Attendance"), strip.textContent ?? "");
    // x=320 of a 44..626 plot is 47.4% of the hour — sample 28, value 128.
    assert.ok(strip.textContent?.includes("128"), strip.textContent ?? "");
  });

  test("leaving the plot puts the chosen figures back", () => {
    render(chart());
    const svg = document.querySelector("svg") as SVGSVGElement;
    fireEvent.pointerMove(svg, { clientX: SVG_W / 2, clientY: 80 });
    fireEvent.pointerLeave(svg);
    assert.equal((document.querySelector("[data-history-strip]") as HTMLElement).dataset.historyStrip, "rest");
  });

  test("hovering a lane segment names the item, its number, and what it ran against plan", () => {
    render(chart());
    const svg = document.querySelector("svg") as SVGSVGElement;
    // Three quarters across = 20:45, inside Message; y in the lower lane row.
    fireEvent.pointerMove(svg, { clientX: 480, clientY: 205 });
    const strip = document.querySelector("[data-history-strip]") as HTMLElement;
    assert.ok(strip.textContent?.includes("Item 3"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("Message"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("Planned"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("30:00"), strip.textContent ?? "");
  });

  test("while recording it reads LIVE with the current values", () => {
    render(chart({ live: true }));
    const strip = document.querySelector("[data-history-strip]") as HTMLElement;
    assert.equal(strip.dataset.historyStrip, "live");
    assert.ok(strip.textContent?.includes("Live"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("160"), strip.textContent ?? "");
  });

  test("a hover wins over LIVE — the operator asked about that instant", () => {
    render(chart({ live: true }));
    fireEvent.pointerMove(document.querySelector("svg") as SVGSVGElement, { clientX: 200, clientY: 80 });
    assert.equal((document.querySelector("[data-history-strip]") as HTMLElement).dataset.historyStrip, "hover");
  });
});

describe("the plot", () => {
  test("hatches the time before and after the service window", () => {
    render(chart());
    const pre = document.querySelector("[data-hatch='pre']") as SVGRectElement;
    const post = document.querySelector("[data-hatch='post']") as SVGRectElement;
    assert.ok(pre, "no pre-service hatch");
    assert.ok(post, "no post-service hatch");
    // A fill, and a PATTERN fill — a flat tint reads as dimmed data.
    assert.match(pre.getAttribute("fill") ?? "", /^url\(#.*hatch\)$/);
    assert.match(post.getAttribute("fill") ?? "", /^url\(#.*hatch\)$/);
    assert.ok(document.querySelector("pattern"), "no hatch pattern defined");
  });

  test("no hatch when the record has no service window to sit inside", () => {
    render(chart({ window: { startedAt: null, endedAt: null } }));
    assert.equal(document.querySelectorAll("[data-hatch='pre']").length, 0);
    assert.equal(document.querySelectorAll("[data-hatch='post']").length, 0);
  });

  test("there is no plot-area fill behind the series", () => {
    // The plot's background is the card's. A rect spanning the plot would be one.
    render(chart());
    const rects = [...document.querySelectorAll("rect")];
    const areaFills = rects.filter((r) => !r.hasAttribute("data-hatch") && !r.hasAttribute("data-lane-segment"));
    assert.equal(areaFills.length, 0, `${areaFills.length} rect(s) behind the series`);
  });

  test("a secondary series draws thinner than the primary", () => {
    render(chart({
      series: [series(), series({ id: "entries", label: "Total entries", role: "secondary", fill: false, dashed: true })],
    }));
    const primary = document.querySelector("[data-series-line='occupancy']") as SVGPathElement;
    const secondary = document.querySelector("[data-series-line='entries']") as SVGPathElement;
    assert.equal(primary.getAttribute("stroke-width"), "1.8");
    assert.equal(secondary.getAttribute("stroke-width"), "1.2");
    assert.equal(secondary.getAttribute("stroke-dasharray"), "4 3");
  });

  test("an empty record says so instead of drawing an axis around nothing", () => {
    render(chart({ series: [series({ points: [] })] }));
    assert.equal(document.querySelectorAll("svg").length, 0);
    assert.ok(screen.getByText(/Nothing recorded yet/));
  });
});

describe("the item lane", () => {
  test("one block per item, pre-service items in their own row", () => {
    render(chart());
    const rows = [...document.querySelectorAll("[data-lane-row]")].map((g) => g.getAttribute("data-lane-row"));
    assert.deepEqual(rows, ["pre", "service", "service"]);
  });

  test("a live item's block reaches the live edge instead of collapsing", () => {
    render(chart({
      live: true,
      items: [{ ...ITEMS[2], endedAt: null }],
      nowMs: T0 + 55 * MIN,
    }));
    const seg = document.querySelector("[data-lane-segment='message']") as SVGRectElement;
    assert.ok(Number(seg.getAttribute("width")) > 50, `collapsed to ${seg.getAttribute("width")}`);
  });

  test("a peak mark only where the caller gave one (the sound chart)", () => {
    render(chart());
    assert.equal(document.querySelectorAll("[data-peak-mark]").length, 0);
    cleanup();
    render(chart({ items: ITEMS.map((i) => ({ ...i, peakLabel: "94 dB" })) }));
    assert.equal(document.querySelectorAll("[data-peak-mark]").length, 3);
  });
});

describe("Customize", () => {
  test("the sliders button opens a popover of the groups and reports the ticked key", async () => {
    const toggled: string[] = [];
    render(
      <CustomizePopover
        label="Customize attendance"
        groups={[
          { id: "series", label: "Series", options: [{ key: "occupancy", label: "Attendance" }] },
          { id: "figures", label: "Figures", options: [{ key: "peak", label: "Peak" }] },
        ]}
        selected={["occupancy"]}
        onToggle={(k) => toggled.push(k)}
      />,
    );
    fireEvent.click(screen.getByLabelText("Customize attendance"));
    fireEvent.click(screen.getByText("Peak"));
    assert.deepEqual(toggled, ["peak"]);
    cleanup();
    await flushReact();
  });

  test("a group with nothing in it is not drawn — an empty heading names nothing", async () => {
    render(
      <CustomizePopover
        label="Customize sound"
        groups={[
          { id: "series", label: "Series", options: [{ key: "laeq", label: "LAeq" }] },
          { id: "metrics", label: "Smaart metrics", options: [] },
        ]}
        selected={[]}
        onToggle={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("Customize sound"));
    assert.ok(screen.getByText("Series"));
    assert.equal(screen.queryAllByText("Smaart metrics").length, 0);
    cleanup();
    await flushReact();
  });
});
