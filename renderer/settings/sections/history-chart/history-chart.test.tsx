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

/**
 * The strip, or a sentence saying it is not there.
 *
 * `document.querySelector(...) as HTMLElement` reads null as an element and the
 * next line dies on `.dataset`, so a chart that stops drawing a strip at all
 * failed ten tests with `Cannot read properties of null` and named nothing. It
 * does go red; it just does not say what broke, which is the failure mode this
 * module's own hover work complained about elsewhere.
 */
function stripEl(): HTMLElement {
  const el = document.querySelector("[data-history-strip]");
  assert.ok(el, "the chart drew no stat strip at all — nothing here can be read off it");
  return el as HTMLElement;
}

describe("the stat strip", () => {
  test("at rest it shows the chosen figures, and only those", () => {
    render(chart());
    const strip = stripEl();
    assert.equal(strip.dataset.historyStrip, "rest");
    for (const f of FIGURES) assert.ok(strip.textContent?.includes(f.label), `${f.label} missing`);
    assert.ok(!strip.textContent?.includes("Live"));
  });

  test("a figure the operator unticked is not in the strip", () => {
    render(chart({ figures: FIGURES.filter((f) => f.key !== "samples") }));
    const strip = stripEl();
    assert.ok(!strip.textContent?.includes("Samples"));
    assert.ok(strip.textContent?.includes("Peak"));
  });

  test("hovering the plot swaps it for the time and the series' value there", () => {
    render(chart());
    const svg = document.querySelector("svg") as SVGSVGElement;
    fireEvent.pointerMove(svg, { clientX: SVG_W / 2, clientY: 80 });
    const strip = stripEl();
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
    assert.equal(stripEl().dataset.historyStrip, "rest");
  });

  test("hovering a lane segment names the item, its number, and what it ran against plan", () => {
    render(chart());
    const svg = document.querySelector("svg") as SVGSVGElement;
    // Three quarters across = 20:45, inside Message; y in the lower lane row.
    fireEvent.pointerMove(svg, { clientX: 480, clientY: 205 });
    const strip = stripEl();
    assert.ok(strip.textContent?.includes("Item 3"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("Message"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("Planned"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("30:00"), strip.textContent ?? "");
  });

  test("while recording it reads LIVE with the current values", () => {
    render(chart({ live: true }));
    const strip = stripEl();
    assert.equal(strip.dataset.historyStrip, "live");
    assert.ok(strip.textContent?.includes("Live"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("160"), strip.textContent ?? "");
  });

  test("a hover wins over LIVE — the operator asked about that instant", () => {
    render(chart({ live: true }));
    fireEvent.pointerMove(document.querySelector("svg") as SVGSVGElement, { clientX: 200, clientY: 80 });
    assert.equal(stripEl().dataset.historyStrip, "hover");
  });
});

describe("a day that has not finished", () => {
  const provisional = () => chart({
    series: [{ ...series(), provisional: true }],
    xAxis: "date",
  });

  test("its last segment is dashed and its node marked; the rest of the line is not", () => {
    // WHAT THIS CANNOT SEE: the dashes. jsdom paints nothing and loads no
    // stylesheet. What it CAN read is what was handed to the SVG — which path
    // carries the dash array, which node is marked, and that the solid path
    // stops one point short. Driven in Chrome at 1440.
    render(provisional());
    const solid = document.querySelector("[data-series-line]");
    const prov = document.querySelector("[data-series-provisional]");
    assert.ok(prov, "no provisional segment at all");
    assert.ok(prov.querySelector("[data-provisional-node]"), "the provisional node is missing");
    assert.match(prov.querySelector("path")?.getAttribute("stroke-dasharray") ?? "", /\d/);
    assert.equal(solid?.getAttribute("stroke-dasharray"), null, "the whole line went dashed");
    // 61 points, 60 of them solid: the newest comes off the line and is drawn
    // by the dashed segment instead.
    assert.equal([...(solid?.getAttribute("d") ?? "").matchAll(/[ML]/g)].length, 60);
  });

  test("a series that is NOT provisional carries neither", () => {
    render(chart({ xAxis: "date" }));
    assert.equal(document.querySelectorAll("[data-series-provisional]").length, 0);
    assert.equal([...(document.querySelector("[data-series-line]")?.getAttribute("d") ?? "").matchAll(/[ML]/g)].length, 61);
  });

  test("REDUCED MOTION drops the pulse, and keeps the dash", () => {
    // The dash is the information; the beat is decoration. Under
    // prefers-reduced-motion the mark must still say "not done yet".
    const real = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }),
    });
    try {
      render(provisional());
      const node = document.querySelector("[data-provisional-node]");
      assert.ok(node, "no provisional node under reduced motion");
      assert.equal(node.getAttribute("class"), null, "the pulse animation survived reduced motion");
      assert.match(
        document.querySelector("[data-series-provisional] path")?.getAttribute("stroke-dasharray") ?? "",
        /\d/,
        "reduced motion took the dash away with the animation",
      );
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: real });
    }
  });

  test("and the pulse is there when motion is allowed", () => {
    // The other half: a guard that only ever sees "no class" would pass on a
    // node that never pulsed at all.
    render(provisional());
    assert.match(
      document.querySelector("[data-provisional-node]")?.getAttribute("class") ?? "",
      /su-history-pulse/,
      "the provisional node never pulses",
    );
  });
});

describe("handing the hover to the caller instead of drawing a strip", () => {
  /** Every value the chart reported, in order. */
  function reporter() {
    const seen: ({ time: string } | null)[] = [];
    return { seen, onHover: (h: { time: string } | null) => seen.push(h) };
  }

  test("a chart that goes away reports null, so nothing is left describing it", () => {
    // The Trends card draws the readout on its own subtitle row. A chart that
    // unmounts with a hover still set — the measure switched, the range emptied,
    // the tab left — leaves that row holding a sentence about a plot that is no
    // longer on the page.
    const { seen, onHover } = reporter();
    const view = render(chart({ onHover }));
    fireEvent.pointerMove(document.querySelector("svg") as SVGSVGElement, { clientX: SVG_W / 2, clientY: 80 });
    assert.ok(seen.at(-1), `the chart never reported a hover, so unmounting proves nothing: ${JSON.stringify(seen)}`);
    view.unmount();
    assert.equal(
      seen.at(-1),
      null,
      `unmounting left the last readout standing: ${JSON.stringify(seen.at(-1))}`,
    );
  });

  test("and it stops drawing a strip, because the caller is drawing one", () => {
    // The other half of the same contract: a chart cannot both hand the hover
    // over and print it, or the Trends card gets two readouts and one of them
    // is over the plot.
    const { onHover } = reporter();
    render(chart({ onHover }));
    assert.equal(
      document.querySelectorAll("[data-history-strip]").length,
      0,
      "the chart is drawing a strip as well as reporting the hover",
    );
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

  test("a series that says it has no sampling gap is never broken", () => {
    // A reference line is two points two hours apart, and a step line holds one
    // level across a 25-minute item. Under the default sampling-gap rule both
    // were cut into single-point runs: the reference line drew as two dots at
    // the edges of the plot, and the step line broke inside every long item.
    const far = [{ t: T0, v: 120 }, { t: T0 + 60 * MIN, v: 120 }];
    render(chart({ series: [series({ id: "ref", points: far, fill: false, gapMs: Infinity })] }));
    assert.equal(document.querySelectorAll("[data-series-line='ref']").length, 1);
    cleanup();
    render(chart({ series: [series({ id: "ref", points: far, fill: false })] }));
    assert.equal(
      document.querySelectorAll("[data-series-line='ref']").length,
      2,
      "the default gap rule should still break a sampled series",
    );
  });

  test("a peak mark runs the full height of its block", () => {
    // It was a 4px nub on the top edge, kept short so it would not cross the
    // item's own title. What that produced was an unexplained coloured chip.
    // It is full height and drawn UNDER the label instead, and named in the
    // legend — see the legend test below.
    render(chart({ items: ITEMS.map((i) => ({ ...i, peakLabel: "94 dB" })) }));
    const g = document.querySelector("[data-lane-row='service']") as SVGGElement;
    const rect = g.querySelector("[data-lane-segment]") as SVGRectElement;
    const mark = g.querySelector("[data-peak-mark]") as SVGLineElement;
    const top = Number(rect.getAttribute("y"));
    assert.equal(Number(mark.getAttribute("y1")), top);
    assert.equal(
      Number(mark.getAttribute("y2")) - top,
      Number(rect.getAttribute("height")),
      "the mark does not span the block",
    );
  });

  test("the time axis is ticked through the service, not only at its ends", () => {
    // The fixture is 20:00 -> 21:00 of samples, so the domain is an hour: the
    // fine step, every ten minutes. Two labels an hour apart say nothing about
    // where in the service a bump happened.
    render(chart());
    const ticks = [...document.querySelectorAll("[data-axis-tick]")];
    assert.equal(ticks.length, 7, `${ticks.length} ticks`); // 20:00…21:00 inclusive
    const labels = [...document.querySelectorAll("[data-axis-label]")].map((e) => e.textContent);
    assert.ok(labels.length >= 4, `only ${labels.length} labels: ${labels.join(",")}`);
  });

  test("an empty record says so instead of drawing an axis around nothing", () => {
    render(chart({ series: [series({ points: [] })] }));
    assert.equal(document.querySelectorAll("svg").length, 0);
    assert.ok(screen.getByText(/Nothing recorded yet/));
  });
});

describe("the live x domain", () => {
  // Shared by both tests below: a service growing one sample a minute, and the
  // DRAWN DOMAIN at each point — not the axis labels and not the last tick.
  //
  // Both of those pass on the bug. A tick hard against an edge has its label
  // dropped, so a label read returns "" on exactly the short domain this
  // starts from; and the last TICK is the last half-hour INSIDE the domain,
  // which does not move when the domain moves by a minute. Proved: with
  // tenMinuteDomainEnd removed, the last-tick version of this test stayed
  // green.
  const points = (n: number) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * MIN, v: 100 + i }));
  const at = (n: number) => chart({
    live: true,
    nowMs: T0 + n * MIN,
    series: [series({ points: points(n + 1) })],
  });
  const rightEdge = () => (document.querySelector("svg[role=img]") as SVGSVGElement).getAttribute("data-domain-end") ?? "";

  test("nine more minutes of samples do not move the right edge", async () => {
    // The domain steps by TEN minutes while recording. Without that it tracks
    // the newest sample, so the whole curve slides leftward once every 30
    // seconds for an hour — the chart is never still while a service runs.
    const view = render(at(1));
    const before = rightEdge();
    assert.notEqual(before, "");
    for (const n of [3, 5, 7, 9]) {
      view.rerender(at(n));
      assert.equal(rightEdge(), before, `the axis moved at ${n} minutes`);
    }
    // And it DOES move once the next ten-minute step is crossed, or the guard
    // would also pass on an axis that never moves at all.
    //
    // AFTER THE EASE, not on the render. `useEasedValue` seeds its tween at the
    // old value in a layout effect, so the step is painted where it was and
    // glides — asserting on the render itself would read the old edge and call
    // a working ease a broken step.
    view.rerender(at(12));
    await new Promise((r) => setTimeout(r, 900));
    assert.notEqual(rightEdge(), before, "the axis never stepped");
  });

  test("the step is painted where the domain WAS, not where it is going", () => {
    // Guards the paint-order bug directly, where the sibling test above
    // cannot: `useEasedValue` used to seed its starting value from a plain
    // effect, which runs AFTER the browser paints. So the render carrying the
    // new target painted AT the target, and only the first animation frame —
    // a real timer here, not something a synchronous rerender() flushes —
    // dropped it back to glide from. The sibling test waits 900ms before
    // reading the domain, long enough for the ease to finish either way, so a
    // reverted fix still leaves it green. This reads with NO wait, right on
    // the render that crosses the ten-minute boundary, which is the one
    // render the bug is in.
    const view = render(at(1));
    const before = rightEdge();
    view.rerender(at(12));
    assert.equal(rightEdge(), before, "the render after the step painted at the target instead of easing from where it was");
  });
});

describe("measuring its own width", () => {
  test("a chart that mounts EMPTY still observes its host", async () => {
    // The width effect runs once, on mount, and returns early when the host is
    // not there. The empty branch used to render without the ref, so a section
    // whose data arrives after the first paint — the sound chart, which fetches
    // its series — never attached the observer and stayed at its 640px default:
    // a half-width plot letterboxed in the middle of a 1,256px card, for the
    // rest of the page's life.
    //
    // jsdom lays nothing out, so this cannot assert the WIDTH. What it can
    // assert is the thing that was missing: that the element the chart renders
    // was handed to a ResizeObserver at all. That is the whole bug.
    const observed: Element[] = [];
    const real = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    };
    try {
      const view = render(chart({ series: [series({ points: [] })] }));
      assert.equal(observed.length, 1, "an empty chart observed nothing");
      // And it is the element that actually wraps the section, not a stray node.
      assert.equal(observed[0].isConnected, true);
      assert.ok(observed[0].textContent?.includes("Peak"), "the observed host is not the chart's wrapper");

      // Data arrives. The observer must still be the one from mount — the effect
      // does not run again — so the host it holds has to be the right element.
      view.rerender(chart());
      assert.equal(observed.length, 1, "the chart re-observed, which the effect deps do not allow");
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = real;
    }
  });
});

describe("the legend", () => {
  test("with a handler it is a row of toggles, each saying whether it is on", () => {
    const toggled: string[] = [];
    render(chart({
      series: [series(), series({ id: "entries", label: "Total entries", role: "secondary", fill: false, on: false })],
      onToggleSeries: (id) => toggled.push(id),
    }));
    const off = document.querySelector("[data-series-toggle='entries']") as HTMLButtonElement;
    assert.equal(off.getAttribute("aria-pressed"), "false");
    assert.equal(
      (document.querySelector("[data-series-toggle='occupancy']") as HTMLButtonElement).getAttribute("aria-pressed"),
      "true",
    );
    fireEvent.click(off);
    assert.deepEqual(toggled, ["entries"]);
  });

  test("a series that is off is LISTED but not drawn", () => {
    // Listed, because a legend that drops what is off can never turn it back on
    // — which is the whole point of it being a toggle.
    render(chart({
      series: [series(), series({ id: "entries", label: "Total entries", role: "secondary", fill: false, on: false })],
      onToggleSeries: () => {},
    }));
    assert.equal(document.querySelectorAll("[data-series-toggle='entries']").length, 1);
    assert.equal(document.querySelectorAll("[data-series-line='entries']").length, 0);
    assert.equal(document.querySelectorAll("[data-series-line='occupancy']").length, 1);
  });

  test("without a handler it is a plain legend, not a dead button", () => {
    render(chart());
    assert.equal(document.querySelectorAll("[data-series-toggle]").length, 0);
  });

  test("every swatch is the LINE it stands for, dashed when the line is", () => {
    // A filled dot for the solid series and a rule for the dashed one were two
    // different kinds of mark for two lines, and on the trend chart — where
    // every series is a solid line of the same weight — a row of dots said
    // nothing about which line was which. Both are now rules; only the dashing
    // differs, which is the only thing that differs on the plot.
    render(chart({
      series: [series(), series({ id: "avg", label: "Avg", role: "secondary", fill: false, dashed: true })],
      onToggleSeries: () => {},
    }));
    const solid = document.querySelector("[data-series-toggle='occupancy'] span") as HTMLElement;
    const dashed = document.querySelector("[data-series-toggle='avg'] span") as HTMLElement;
    assert.ok(solid.className.includes("border-t-2"), `solid swatch: ${solid.className}`);
    assert.ok(!solid.className.includes("border-dashed"), "the solid series got a dashed rule");
    assert.ok(dashed.className.includes("border-dashed"), `dashed swatch: ${dashed.className}`);
    assert.ok(!dashed.className.includes("rounded-full"), "the dashed series got a dot");
  });
});

describe("the item lane", () => {
  test("one block per item, pre-service items in their own row", () => {
    render(chart());
    const rows = [...document.querySelectorAll("[data-lane-row]")].map((g) => g.getAttribute("data-lane-row"));
    assert.deepEqual(rows, ["pre", "service", "service"]);
  });

  test("a pre-service item's extra lane pushes the service row DOWN, not onto it", () => {
    // Seen on the 17 Sep record: "10 min Warning" (pre-service, stacked into
    // lane 1 because it overlaps "Doors") landed on the same line as
    // "VIDEO: Pre-roll" (in-service, lane 0), and the two drew on top of each
    // other — the exact invisibility the stacking was added to fix, moved one
    // row over. Every block must be on a line of its own or beside another
    // block, never underneath one.
    render(chart({
      items: [
        { ...ITEMS[0], itemId: "doors", title: "Doors", sequence: 0, preService: true, startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 26 * MIN).toISOString() },
        { ...ITEMS[0], itemId: "warn", title: "10 min Warning", sequence: 1, preService: true, startedAt: new Date(T0 + 16 * MIN).toISOString(), endedAt: new Date(T0 + 26 * MIN).toISOString() },
        { ...ITEMS[1], itemId: "preroll", title: "VIDEO: Pre-roll", sequence: 2, preService: false, startedAt: new Date(T0 + 16 * MIN).toISOString(), endedAt: new Date(T0 + 27 * MIN).toISOString() },
      ],
    }));
    const placed = [...document.querySelectorAll("[data-lane-row]")].map((g) => {
      const r = g.querySelector("[data-lane-segment]") as SVGRectElement;
      return {
        id: r.getAttribute("data-lane-segment"),
        y: Number(r.getAttribute("y")),
        x0: Number(r.getAttribute("x")),
        x1: Number(r.getAttribute("x")) + Number(r.getAttribute("width")),
      };
    });
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const sameLine = a.y === b.y;
        const overlapX = a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5;
        assert.ok(
          !(sameLine && overlapX),
          `${a.id} and ${b.id} are stacked on line y=${a.y}: ${a.x0}-${a.x1} vs ${b.x0}-${b.x1}`,
        );
      }
    }
    // And the svg grew to hold the extra line, or the stacked block is clipped
    // away and is invisible for a different reason.
    const svg = document.querySelector("svg[role=img]") as SVGSVGElement;
    const bottom = Math.max(...placed.map((p) => p.y)) + 16;
    assert.ok(Number(svg.getAttribute("height")) >= bottom, `svg is ${svg.getAttribute("height")} tall, needs ${bottom}`);
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

  test("hovering an item with a peak puts the NUMBER in the strip", () => {
    // A tick on a block with the number nowhere is a mark nobody can read.
    render(chart({ items: ITEMS.map((i) => ({ ...i, peakLabel: "94 dB" })) }));
    fireEvent.pointerMove(document.querySelector("svg") as SVGSVGElement, { clientX: 480, clientY: 205 });
    const strip = stripEl();
    assert.ok(strip.textContent?.includes("Peaked at"), strip.textContent ?? "");
    assert.ok(strip.textContent?.includes("94 dB"), strip.textContent ?? "");
  });

  test("an item with no peak gets no empty Peaked column", () => {
    render(chart());
    fireEvent.pointerMove(document.querySelector("svg") as SVGSVGElement, { clientX: 480, clientY: 205 });
    const strip = stripEl();
    assert.ok(strip.textContent?.includes("Item 3"), "the lane hover did not register");
    assert.ok(!strip.textContent?.includes("Peaked at"), strip.textContent ?? "");
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
