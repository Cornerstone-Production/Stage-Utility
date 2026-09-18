// Milestone marks, and the date axis they sit under.
//
// WHAT IS NOT ASSERTED HERE, AND WHY. jsdom lays nothing out: every
// getBoundingClientRect() is zeros, no stylesheet is loaded, and there is no
// canvas 2d context, so the label rule falls back to measure-text.ts's estimate.
// A label overlapping its neighbour, the dashed guide's dash pattern, and the
// accent a hovered mark takes are all invisible to it and were driven in Chrome
// at 1280 and 600, light and dark, against a real three-month archive.
//
// What IS here: the marks that are drawn at all, the fit rule as arithmetic,
// and the one structural fact worth pinning — a chart given no milestones draws
// none, which is what keeps them off a single service's page.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../../test-dom.js";
import { dateTicks, type ChartSeries } from "./geometry.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { HistoryChart, fitLabel, keepAxisLabels, AXIS_LABEL_GAP } = await import("./history-chart.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

const DAY = 24 * 60 * 60_000;
const START = Date.parse("2026-01-04T15:00:00Z");

/** Ten weekly recordings — the Trends chart's shape: one point per service, no
 *  item lane, no service window. */
const SERIES: ChartSeries[] = [
  {
    id: "weekend",
    label: "Weekend",
    color: "var(--color-green-9)",
    role: "primary" as const,
    gapMs: Infinity,
    points: Array.from({ length: 10 }, (_, i) => ({ t: START + i * 7 * DAY, v: 900 + i * 10 })),
  },
];

type Mark = { id: string; t: number; label: string; kind: "operator" | "series"; seriesId?: string | null };

function drawTrend(milestones?: Mark[], series: ChartSeries[] = SERIES) {
  return render(
    React.createElement(HistoryChart, {
      series,
      items: [],
      window: { startedAt: null, endedAt: null },
      yScale: { kind: "count" as const },
      xAxis: "date" as const,
      milestones,
      figures: [],
      ariaLabel: "Peak attendance per recording",
    }),
  );
}

/** The Weekend line, plus a second type that can be switched off. */
const TWO_SERIES: ChartSeries[] = [
  SERIES[0],
  {
    id: "youth",
    label: "Youth",
    color: "var(--color-accent)",
    role: "secondary" as const,
    gapMs: Infinity,
    points: Array.from({ length: 10 }, (_, i) => ({ t: START + i * 7 * DAY, v: 200 + i })),
  },
];

describe("milestone marks", () => {
  test("one group per milestone, each with a triangle, a guide and its full label in a title", () => {
    const marks = [
      { id: "m1", t: START + 2 * 7 * DAY, label: "New building", kind: "operator" as const },
      { id: "m2", t: START + 6 * 7 * DAY, label: "Everyday", kind: "series" as const },
    ];
    const r = drawTrend(marks);
    const groups = [...r.container.querySelectorAll("[data-milestone]")];
    assert.deepEqual(groups.map((g) => g.getAttribute("data-milestone")), ["m1", "m2"]);
    assert.deepEqual(groups.map((g) => g.getAttribute("data-milestone-kind")), ["operator", "series"]);
    for (const [i, g] of groups.entries()) {
      assert.equal(g.querySelector("title")?.textContent, marks[i].label, "the full label is always reachable");
      assert.equal(g.querySelectorAll("path").length, 1, "the triangle");
      assert.equal(g.querySelectorAll("line").length, 1, "the dashed guide up the plot");
    }
    r.unmount();
  });

  test("a chart given no milestones draws none", () => {
    // This is what keeps milestones off a single service's page: the prop is
    // opt-in, and only the Trends card passes it. "We moved to two services" is
    // a statement about the history, not about the 9 o'clock on the 13th.
    const r = drawTrend();
    assert.equal(r.container.querySelectorAll("[data-milestone]").length, 0);
    r.unmount();
  });

  test("a mark outside the drawn domain is not placed on the edge", () => {
    const r = drawTrend([{ id: "old", t: START - 400 * DAY, label: "Old building", kind: "operator" }]);
    assert.equal(
      r.container.querySelectorAll("[data-milestone]").length,
      0,
      "a mark from before the range would otherwise pile up at the left edge, reading as a date it is not",
    );
    r.unmount();
  });
});

describe("the label rule", () => {
  test("the full label when it fits, a truncation when it does not, nothing when even that will not", () => {
    // Fixed measurer: 6px a character, so the arithmetic is the assertion
    // rather than whatever font the machine running this happens to have.
    const measure = (t: string) => t.length * 6;
    assert.equal(fitLabel("Everyday", 100, measure), "Everyday", "60px of label in 100px of room");
    assert.equal(fitLabel("Everyday", 40, measure), "Every…", "36px is the most that fits in 40");
    assert.equal(fitLabel("Everyday", 10, measure), "", "nothing is ever clipped — the title carries it instead");
    assert.equal(fitLabel("   ", 100, measure), "", "a blank label draws nothing");
  });
});

describe("the date axis", () => {
  test("a range of weeks is labelled in dates, not in times of day", () => {
    const r = drawTrend();
    const labels = [...r.container.querySelectorAll("[data-axis-label]")].map((n) => n.textContent ?? "");
    assert.ok(labels.length > 0, "the axis drew no labels at all");
    assert.equal(
      labels.filter((l) => /^\d{1,2}:\d{2}/.test(l)).length,
      0,
      `a ten-week domain labelled in clock times is the bug: ${labels.join(", ")}`,
    );
    r.unmount();
  });

  test("the tick step widens with the domain, so a year is not four hundred ticks", () => {
    const week = 7 * DAY;
    assert.equal(dateTicks(START, START + 8 * week).length, 8, "weekly over eight weeks");
    assert.equal(dateTicks(START, START + 16 * week).length, 8, "fortnightly over sixteen");
    // 52 weeks at four-weekly is 13.
    assert.equal(dateTicks(START, START + 52 * week).length, 13, "four-weekly over a year");
    assert.deepEqual(dateTicks(START, START), [], "an empty domain has no ticks");
  });
});

describe("a milestone scoped to one service type", () => {
  const scoped: Mark = { id: "youth-move", t: START + 3 * 7 * DAY, label: "Youth moved", kind: "operator", seriesId: "youth" };
  const everyone: Mark = { id: "building", t: START + 5 * 7 * DAY, label: "New building", kind: "operator" };

  test("draws in its own series' colour while that series is on", () => {
    const r = drawTrend([scoped, everyone], TWO_SERIES);
    const g = r.container.querySelector('[data-milestone="youth-move"]')!;
    assert.equal(g.getAttribute("data-milestone-series"), "youth");
    assert.equal(
      g.querySelector("path")!.getAttribute("fill"),
      "var(--color-accent)",
      "a scoped mark takes its series' colour, or which line it is about is unreadable",
    );
    assert.equal(g.querySelector("line")!.getAttribute("stroke"), "var(--color-accent)");
    r.unmount();
  });

  test("an unscoped mark stays neutral — a colour would claim a series it has not got", () => {
    const r = drawTrend([scoped, everyone], TWO_SERIES);
    const g = r.container.querySelector('[data-milestone="building"]')!;
    assert.equal(g.getAttribute("data-milestone-series"), null);
    assert.equal(g.querySelector("path")!.getAttribute("fill"), "var(--color-fg-muted)");
    assert.equal(g.querySelector("line")!.getAttribute("stroke"), "var(--color-line-strong)");
    r.unmount();
  });

  test("is not drawn at all once its series is switched off", () => {
    // Left drawn, it reads as a statement about whichever line is still on
    // screen. The unscoped one stays: it was never about one type.
    const off = [SERIES[0], { ...TWO_SERIES[1], on: false }];
    const r = drawTrend([scoped, everyone], off);
    assert.deepEqual(
      [...r.container.querySelectorAll("[data-milestone]")].map((g) => g.getAttribute("data-milestone")),
      ["building"],
    );
    r.unmount();
  });

  test("a mark scoped to a series the chart does not carry is not drawn", () => {
    const r = drawTrend([{ ...scoped, seriesId: "nobody" }], TWO_SERIES);
    assert.equal(r.container.querySelectorAll("[data-milestone]").length, 0);
    r.unmount();
  });
});

describe("reaching a milestone without a pointer", () => {
  test("each mark is a focusable control named by its full label", () => {
    // The triangle is 8px of glyph carrying the only copy of a sentence.
    // Reachable by pointer alone it was unreadable to a keyboard and to a
    // screen reader, whatever the <title> said.
    const r = drawTrend([{ id: "m", t: START + 2 * 7 * DAY, label: "Moved to two services", kind: "operator" }]);
    const g = r.container.querySelector("[data-milestone]")!;
    assert.equal(g.getAttribute("role"), "button");
    assert.equal(g.getAttribute("tabindex"), "0");
    assert.equal(g.getAttribute("aria-label"), "Moved to two services");
    r.unmount();
  });

  test("focus reveals more of the label than the at-rest fit had room for", () => {
    // Two marks a week apart: at rest the first is cut off by the second's
    // position, and focusing it frees the room out to the plot's right edge.
    // A single mark with the whole plot to its right prints the full label
    // anyway and would prove nothing about focus.
    const long = "Moved to two services";
    const r = drawTrend([
      { id: "m", t: START + 2 * 7 * DAY, label: long, kind: "operator" },
      { id: "n", t: START + 3 * 7 * DAY, label: "Next", kind: "operator" },
    ]);
    const g = r.container.querySelector<SVGGElement>('[data-milestone="m"]')!;
    const before = g.querySelector("[data-milestone-label]")?.textContent ?? "";
    fireEvent.focus(g);
    const after = g.querySelector("[data-milestone-label]")?.textContent ?? "";
    assert.ok(
      after.length > before.length,
      `focus showed "${after}" where at rest showed "${before}"`,
    );
    assert.equal(after, long, "with the plot's width to play with, the whole label fits");
    r.unmount();
  });
});

describe("the label rule under a pointer", () => {
  test("a hovered label is fitted to the room, not let run off the plot", () => {
    // The at-rest label was fitted and the hovered one was not, so a long label
    // on the LAST mark ran past the plot's right edge and was clipped by the
    // viewBox — the one thing the lane's own label rule forbids. jsdom has no
    // canvas, so this asserts through the estimate measurer, which is
    // deliberately generous and still nowhere near 60 characters of room.
    const long = "Moved to two services and opened the east building";
    // Far right: the default 640px chart puts plotX1 at 626, so a mark at the
    // last sample has ~10px to play with.
    const r = drawTrend([{ id: "m", t: START + 9 * 7 * DAY, label: long, kind: "operator" }]);
    const g = r.container.querySelector<SVGGElement>("[data-milestone]")!;
    fireEvent.pointerEnter(g);
    const shown = g.querySelector("[data-milestone-label]")?.textContent ?? "";
    assert.equal(
      shown,
      "",
      "at the right-hand edge there is no room for any of it, and nothing is ever clipped — " +
        `printing it whole is the bug: got "${shown}"`,
    );
    assert.equal(g.querySelector("title")?.textContent, long, "the full label is still reachable");
    r.unmount();
  });
});

describe("one dot per underlying reading", () => {
  test("a line whose nodes summarise several readings still marks each of them", () => {
    // Three Sundays of three services: three line points, nine dots. Without
    // the dots a church with three services a week sees one point a week and no
    // way to tell it stood for three.
    const days = [0, 7, 14].map((d) => START + d * DAY);
    const series: ChartSeries[] = [
      {
        ...SERIES[0],
        points: days.map((t, i) => ({ t, v: 1400 + i })),
        dots: days.flatMap((t, i) => [
          { t, v: 1400 + i },
          { t: t + 2 * 60 * 60_000, v: 700 },
          { t: t + 9 * 60 * 60_000, v: 1100 },
        ]),
      },
    ];
    const r = drawTrend(undefined, series);
    const line = r.container.querySelector("[data-series-line]")!.getAttribute("d") ?? "";
    assert.equal(line.split("L").length, 3, `the line runs through three day points: ${line}`);
    assert.equal(r.container.querySelectorAll("[data-series-dot]").length, 9, "one dot per recording");
    r.unmount();
  });

  test("a series with no dots draws none", () => {
    const r = drawTrend();
    assert.equal(r.container.querySelectorAll("[data-series-dot]").length, 0);
    r.unmount();
  });
});

describe("fitting a label is not one measurement per character", () => {
  test("a long label costs a handful of measurements, not sixty", () => {
    // `measure` is a canvas measureText and the chart redraws on every resize
    // frame. Walking down from the full length measured 57 strings and threw
    // away 56 of the answers.
    let calls = 0;
    const measure = (t: string) => {
      calls += 1;
      return t.length * 6;
    };
    const long = "Moved to two services and opened the east building";
    const fitted = fitLabel(long, 60, measure);
    assert.equal(fitted, "Moved to\u2026", `got "${fitted}"`);
    // ceil(log2(49)) + 1 for the full-string check = 7. A walk is 40+.
    assert.ok(calls <= 10, `binary search must not measure once per character — took ${calls}`);
  });
});

describe("the axis keep rule", () => {
  /** Ticks every 50px across a 500px plot, each label `width` px wide. */
  const fixture = (width: number) => ({
    ticks: Array.from({ length: 10 }, (_, i) => i),
    opts: {
      // 80…530, inside a 50…550 plot, so the edge rule is not what is under
      // test here — every label has room at both ends.
      xOf: (t: number) => 80 + t * 50,
      text: () => "Aug 24",
      measure: () => width,
      plotX0: 50,
      plotX1: 550,
    },
  });

  test("labels that fit with air between them are all kept", () => {
    const { ticks, opts } = fixture(30);
    assert.deepEqual([...keepAxisLabels(ticks, opts)], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("a label that would touch the last one kept is dropped, and the tick stays", () => {
    // 48px labels on a 50px pitch leave 2px of air — under AXIS_LABEL_GAP — so
    // every other one goes. Without the gap rule all ten would be kept and the
    // axis would read as one long word.
    const { ticks, opts } = fixture(48);
    assert.ok(AXIS_LABEL_GAP > 2, "the fixture only means something while the gap is wider than the air");
    assert.deepEqual([...keepAxisLabels(ticks, opts)], [0, 2, 4, 6, 8]);
  });

  test("a label hanging off either end is dropped", () => {
    const { ticks, opts } = fixture(30);
    // The first tick sits ON plotX0, so half its label hangs off the left.
    assert.equal(keepAxisLabels(ticks, { ...opts, plotX0: 70 }).has(0), false);
    assert.equal(keepAxisLabels(ticks, { ...opts, plotX1: 520 }).has(9), false);
  });
});
