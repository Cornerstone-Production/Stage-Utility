// The Overview blend: what it draws, and what it must NOT draw.
//
// Two things reported from screenshots. The SPL line had no summary of its own,
// so one attendance figure sat above a chart with two series in it and the green
// line read as bolted on; and right-clicking the chart opened the menu with the
// chart's tooltip still tracking the pointer underneath it, drawn through the
// menu it had just opened.
//
// Both are absences as much as presences — a summary that appears when there is
// no level to report is as wrong as one that never appears — so the tests below
// assert something positive alongside every absence. An "it is not there" that
// passes because nothing rendered at all is not a test.
//
// Cleanup lives in `t.after()`, not a trailing statement: a `cleanup()` or
// `document.querySelector` written as the LAST line of a test is skipped the
// moment an earlier assertion throws, which is exactly the failure that let a
// menu opened by one test answer a `document.querySelector('[role="menu"]')` in
// a later one. `t.after()` runs regardless of how the test ends.
//
// jsdom lays nothing out and loads no stylesheet, so what these CANNOT see is
// where anything ended up. The menu opening on top of the chart, the tooltip it
// suppresses, and the summary's type against the attendance block above it were
// driven in headless Chrome against a seeded history instead.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { OverviewBlend } = await import("./service-history-section.js");
type OverviewData = import("./overview-data.js").OverviewData;

after(() => {
  cleanup();
  teardown();
});

const pt = (day: string, value: number, spl: number | null) => ({ day, value, spl, live: false });

function overviewData(over: Partial<OverviewData> = {}): OverviewData {
  return {
    avgAttendance: "2,355",
    attTrend: { dir: "up", tone: "good", pct: 0.12, priorCount: 4 },
    attPoints: [
      pt("2026-07-05", 2100, 80),
      pt("2026-07-12", 2200, 80),
      pt("2026-07-19", 2150, 80),
      pt("2026-07-26", 2300, 80),
      pt("2026-08-02", 2355, 100),
    ],
    services: "10",
    avgLength: "1:05",
    avgStart: "0:30 late",
    avgStartEarly: false,
    avgStartLate: false,
    avgOverrun: "+1:00",
    overrunTrend: null,
    peakAttendance: "2,600",
    scopeName: "Weekend",
    splMetrics: ["LAeq 10"],
    splMetric: "LAeq 10",
    avgSpl: 94.3,
    splDelta: { dir: "up", db: 20, priorCount: 4 },
    ...over,
  };
}

/** Everything the card says, with its line breaks flattened. */
const text = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

/** The chart's hover tooltip — its only z-10 overlay. */
const tooltip = (c: HTMLElement) => c.querySelector<HTMLElement>("div.z-10");

/** The SPL summary block itself, present only while the line is on AND there
 *  is a level to report — see the `data-testid` in OverviewBlend. */
const splSummary = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="spl-summary"]');

function show(over: Partial<OverviewData> = {}, shown = true) {
  return render(
    <OverviewBlend
      overview={overviewData(over)}
      splTrend={{ shown, metric: "LAeq 10" }}
      onSplTrend={() => {}}
    />,
  );
}

describe("the SPL summary under the lead stat", () => {
  test("reads like the attendance summary above it: an average, then a comparison", (t) => {
    const view = show();
    t.after(() => cleanup());
    const txt = text(view.container);
    assert.ok(txt.includes("Avg SPL"), `no SPL summary at all: ${txt}`);
    assert.ok(txt.includes("94.3"), `the average level is missing: ${txt}`);
    // dB, NOT a percentage. A percentage of a logarithmic quantity says nothing
    // about how loud it was, which is why this does not reuse the attendance
    // line's "+12%" shape.
    assert.ok(
      txt.includes("+20.0 dB vs the prior 4 Weekends"),
      `the comparison is not a dB delta phrased like the attendance one: ${txt}`,
    );
  });

  test("draws no arrow when the change is inside the deadband", (t) => {
    // SplDelta.dir === "flat": a change too small to be a real direction. This
    // block is never coloured, so an arrow is the only signal it has — one
    // drawn for a nothing-change would read as a judged direction with
    // nothing left to soften it. Scoped to the summary block itself: the
    // attendance trend above it (unrelated, still "up" in this fixture) has
    // its own arrow, so a whole-card scan would fail for the wrong reason.
    const view = show({ splDelta: { dir: "flat", db: -0.04, priorCount: 4 } });
    t.after(() => cleanup());
    const summary = splSummary(view.container);
    assert.ok(summary, "no SPL summary at all for a flat change");
    const summaryText = text(summary!);
    assert.ok(
      !summaryText.includes("▲") && !summaryText.includes("▼"),
      `an arrow was drawn for a flat change: ${summaryText}`,
    );
    assert.ok(
      summaryText.includes("±0.0 dB vs the prior 4 Weekends"),
      `a flat change should read with a neutral sign, not a signed one: ${summaryText}`,
    );
  });

  test("is absent when the SPL line is switched off", (t) => {
    const view = show({}, false);
    t.after(() => cleanup());
    const txt = text(view.container);
    assert.ok(txt.includes("2,355"), `nothing rendered, so this asserts nothing: ${txt}`);
    // The BLOCK itself, not a text scan for "dB" over the whole card: a scan
    // that broad fails the moment anything else in this component ever prints
    // a dB figure, for a reason that has nothing to do with this toggle.
    assert.ok(!splSummary(view.container), `the SPL summary block is drawn with the line switched off: ${txt}`);
  });

  test("is absent when no weekend in scope carries a level", (t) => {
    // No placeholder and no dash: "— dB" reads as a measured silence.
    const view = show({ avgSpl: null, splDelta: null, splMetric: null, splMetrics: [] });
    t.after(() => cleanup());
    const txt = text(view.container);
    assert.ok(txt.includes("2,355"), `nothing rendered, so this asserts nothing: ${txt}`);
    assert.ok(!txt.includes("Avg SPL"), `the SPL summary is drawn with no level to report: ${txt}`);
    assert.ok(!txt.includes("—"), `a dash is standing in for a level nobody measured: ${txt}`);
  });

  test("keeps the average but drops the comparison when there is no prior weekend", (t) => {
    const view = show({ splDelta: null });
    t.after(() => cleanup());
    const txt = text(view.container);
    assert.ok(txt.includes("Avg SPL") && txt.includes("94.3"), `the average went missing with it: ${txt}`);
    // "dB vs the prior", not "vs the prior": the attendance comparison above it
    // is still there and says the same words about a different number.
    assert.ok(!txt.includes("dB vs the prior"), `a comparison was invented out of one weekend: ${txt}`);
  });
});

describe("the right-click menu", () => {
  test("takes the chart's hover down while it is open", (t) => {
    // jsdom lays nothing out, so the chart's box measures zero wide and any
    // pointer move lands on the last point. That is all this needs: a hover.
    const view = show();
    t.after(() => cleanup());
    const svg = view.container.querySelector("svg")!;
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 40 });
    assert.ok(tooltip(view.container), "no tooltip to conflict with: this asserts nothing");

    fireEvent.contextMenu(svg, { clientX: 400, clientY: 40 });
    assert.ok(document.querySelector('[role="menu"]'), "the right-click menu never opened");
    assert.ok(
      !tooltip(view.container),
      "the chart's tooltip is still drawn while the menu it opened is on top of it",
    );
  });
});
