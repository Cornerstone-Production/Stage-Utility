// The Overview blend: what it draws, and what it must NOT draw.
//
// It is the TIMING card now — services, average length, average start, average
// overrun — plus the sound summary. Attendance left it entirely: Trends, at the
// top of All services, plots attendance per service type over a chosen range,
// and this card plotted the same quantity over a different window with a
// different average. Two charts of attendance on one screen that disagreed.
//
// What went with the attendance chart, and where the coverage went:
//
//   the lead attendance stat, Peak attendance   Trends, and the day-list rows
//   the two series legend dots                  gone with the chart they keyed
//   the SPL TREND LINE                          gone; the level summary stays
//   hover suppressed while the menu is open     attendance-trend-chart.test.tsx,
//                                               which still owns that chart for
//                                               Home's card
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
// where anything ended up. The menu's position over the card, and the summary's
// type, were driven in headless Chrome against a seeded history instead.

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

/** The SPL summary block itself, present exactly when there IS a level to
 *  report — see the `data-testid` in OverviewBlend. */
const splSummary = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="spl-summary"]');

function show(over: Partial<OverviewData> = {}) {
  return render(<OverviewBlend overview={overviewData(over)} onSplTrend={() => {}} />);
}

/** Every sentence on the card — anything with a space and a lower-case word,
 *  which is prose rather than a label or a figure. */
function prose(el: HTMLElement): string[] {
  return [...el.querySelectorAll("div, p, span")]
    .map((n) => (n.textContent ?? "").trim())
    .filter((t) => /[a-z]/.test(t) && /\s/.test(t) && !/^[A-Z][a-z]+ [a-z]+$/.test(t))
    .filter((t) => /\.|right-click|switched off|is off/i.test(t));
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
    // dB, and "recordings" — not the service type's own name, which is a proper
    // noun and pluralised into "vs the prior 4 The Salt Companys".
    assert.ok(
      txt.includes("+20.0 dB vs the prior 4 recordings"),
      `the comparison is not a dB delta, phrased for a proper noun: ${txt}`,
    );
  });

  test("the card carries no attendance figure at all", (t) => {
    // The whole reason this card was trimmed. It showed an average attendance
    // and a peak over its own window while Trends showed an average over
    // another, on the same screen, disagreeing. Asserted as an ABSENCE with a
    // positive beside it: the timing figures must still be there, or this would
    // pass on a card that rendered nothing.
    const view = show();
    t.after(() => cleanup());
    const txt = text(view.container);
    assert.ok(txt.includes("Avg length") && txt.includes("Avg overrun"), `the timing figures went too: ${txt}`);
    assert.equal(txt.includes("2,355"), false, `the attendance lead stat is still on the card: ${txt}`);
    assert.equal(txt.includes("Peak attendance"), false, `the peak attendance figure is still on the card: ${txt}`);
    assert.equal(
      view.container.querySelectorAll("svg").length,
      0,
      "the attendance chart is still drawn — two charts of attendance that do not agree",
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
      summaryText.includes("±0.0 dB vs the prior 4 recordings"),
      `a flat change should read with a neutral sign, not a signed one: ${summaryText}`,
    );
  });

  test("the card is four timing figures and no prose", (t) => {
    // It printed "Sound summary is off — right-click for options." above the
    // timings: a sentence advertising a hidden switch whose only effect was to
    // hide a figure that has no reason to be hidden. Both are gone. A card that
    // needs a paragraph to explain what it is not showing is showing the wrong
    // thing.
    const view = show({ avgSpl: null, splDelta: null, splMetric: null, splMetrics: [] });
    t.after(() => cleanup());
    const labels = [...view.container.querySelectorAll("div")]
      .map((n) => (n.textContent ?? "").trim())
      .filter((t2) => /^(Services|Avg length|Avg start|Avg overrun)$/.test(t2));
    assert.deepEqual(
      labels.sort(),
      ["Avg length", "Avg overrun", "Avg start", "Services"],
      "the four timing figures must be there, or this asserts nothing",
    );
    assert.deepEqual(prose(view.container), [], "the card is carrying prose");
  });

  test("is absent when no weekend in scope carries a level", (t) => {
    // No placeholder and no dash: "— dB" reads as a measured silence.
    const view = show({ avgSpl: null, splDelta: null, splMetric: null, splMetrics: [] });
    t.after(() => cleanup());
    const txt = text(view.container);
    assert.ok(txt.includes("Avg length"), `nothing rendered, so this asserts nothing: ${txt}`);
    assert.ok(!txt.includes("Avg SPL"), `the SPL summary is drawn with no level to report: ${txt}`);
    assert.ok(!txt.includes("— dB"), `a dash is standing in for a level nobody measured: ${txt}`);
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
  test("offers the metric, and nothing that hides a figure", (t) => {
    // What is left of it. The "SPL trend line" entry gated a line on a chart
    // this card no longer draws; the "Sound summary" entry that replaced it
    // gated the level itself, which is the card's own summary and has no reason
    // to be switchable. Choosing WHICH metric the level is read from is a real
    // choice and stays.
    //
    // The tooltip-suppression half of this test went with the chart; the chart
    // itself still serves Home, and attendance-trend-chart.test.tsx still
    // covers `hoverSuppressed` there.
    const view = show();
    t.after(() => cleanup());
    fireEvent.contextMenu(view.container.firstElementChild!.firstElementChild!, { clientX: 400, clientY: 40 });
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu, "the right-click menu never opened");
    const txt = menu.textContent ?? "";
    assert.ok(txt.includes("Metric"), `the metric picker went too: ${txt}`);
    assert.equal(/Sound summary|trend line/.test(txt), false, `the menu still hides a figure: ${txt}`);
  });

  test("the menu is absent entirely when there is no metric to choose", (t) => {
    // A menu with nothing in it is a right-click that opens an empty box.
    const view = show({ avgSpl: null, splDelta: null, splMetric: null, splMetrics: [] });
    t.after(() => cleanup());
    fireEvent.contextMenu(view.container.firstElementChild!.firstElementChild!, { clientX: 10, clientY: 10 });
    assert.equal(document.querySelector('[role="menu"]'), null);
  });
});
