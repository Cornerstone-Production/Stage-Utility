import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();
const { plottedMetric, plottedFor, readPlotChoice, writePlotChoice, peakFigureLabel, peakSeriesLabel, PLOT_STORAGE_KEY } = await import("./sound-plot.js");
after(teardown);

const ALL = ["FS Peak", "LAeq 15", "LCeq", "SPL A Slow"];
const OLD = ["LAeq 15", "LCeq", "SPL A Slow"];

describe("plottedMetric", () => {
  test("this browser's own choice wins when the record carries it", () => {
    assert.deepEqual(plottedMetric(ALL, "FS Peak", "SPL A Slow"), { metric: "FS Peak", wanted: null, trends: "SPL A Slow" });
  });

  test("with no choice it plots the Trends metric", () => {
    assert.deepEqual(plottedMetric(ALL, null, "SPL A Slow"), { metric: "SPL A Slow", wanted: null, trends: "SPL A Slow" });
  });

  test("with neither saved, Trends' own default applies: LAeq 2, else LAeq 1, else the first", () => {
    assert.equal(plottedMetric(["LAeq 1", "LAeq 2", "X"], null, null)?.metric, "LAeq 2");
    assert.equal(plottedMetric(["LAeq 1", "X"], null, null)?.metric, "LAeq 1");
    assert.equal(plottedMetric(["B", "A"], null, null)?.metric, "B", "the first recorded, in the order given");
  });

  test("a choice this record lacks falls back to the Trends metric and names what it wanted", () => {
    assert.deepEqual(plottedMetric(OLD, "FS Peak", "SPL A Slow"), { metric: "SPL A Slow", wanted: "FS Peak", trends: "SPL A Slow" });
  });

  test("a Trends metric this record lacks falls back to the first recorded and says so", () => {
    assert.deepEqual(plottedMetric(OLD, null, "FS Peak"), { metric: "LAeq 15", wanted: "FS Peak", trends: "FS Peak" });
  });

  test("neither the choice nor Trends recorded: the first recorded, wanting the choice", () => {
    assert.deepEqual(plottedMetric(["LCeq", "SPL A Slow"], "FS Peak", "LAeq 2"), { metric: "LCeq", wanted: "FS Peak", trends: "LAeq 2" });
  });

  test("a record with no metric plots nothing", () => {
    assert.equal(plottedMetric([], "FS Peak", "LAeq 2"), null);
  });
});

describe("the stored choice", () => {
  beforeEach(() => localStorage.clear());

  test("reads what was written, and null once cleared", () => {
    assert.equal(readPlotChoice(), null);
    assert.equal(writePlotChoice("FS Peak"), null);
    assert.equal(readPlotChoice(), "FS Peak");
    assert.equal(writePlotChoice(null), null);
    assert.equal(readPlotChoice(), null);
  });

  test("an unreadable or non-string value is no choice", () => {
    localStorage.setItem(PLOT_STORAGE_KEY, "{not json");
    assert.equal(readPlotChoice(), null);
    localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify(["FS Peak"]));
    assert.equal(readPlotChoice(), null);
  });

  test("plottedFor reads it, and ignores the table columns entirely", () => {
    localStorage.setItem("spl:visibleMetrics", JSON.stringify(["LCeq"]));
    assert.equal(plottedFor(ALL, "SPL A Slow")?.metric, "SPL A Slow", "a ticked column is not a plot choice");
    writePlotChoice("FS Peak");
    assert.equal(plottedFor(ALL, "SPL A Slow")?.metric, "FS Peak");
  });
});

describe("labels", () => {
  test("never double Peak", () => {
    assert.equal(peakSeriesLabel("FS Peak"), "FS Peak");
    assert.equal(peakSeriesLabel("SPL A Slow"), "SPL A Slow peak");
    assert.equal(peakFigureLabel("FS Peak"), "FS Peak");
    assert.equal(peakFigureLabel("SPL A Slow"), "Peak SPL A Slow");
  });
});
