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
import { dateTicks } from "./geometry.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { HistoryChart, fitLabel } = await import("./history-chart.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

const DAY = 24 * 60 * 60_000;
const START = Date.parse("2026-01-04T15:00:00Z");

/** Ten weekly recordings — the Trends chart's shape: one point per service, no
 *  item lane, no service window. */
const SERIES = [
  {
    id: "weekend",
    label: "Weekend",
    color: "var(--color-green-9)",
    role: "primary" as const,
    gapMs: Infinity,
    points: Array.from({ length: 10 }, (_, i) => ({ t: START + i * 7 * DAY, v: 900 + i * 10 })),
  },
];

function drawTrend(milestones?: { id: string; t: number; label: string; kind: "operator" | "series" }[]) {
  return render(
    React.createElement(HistoryChart, {
      series: SERIES,
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
