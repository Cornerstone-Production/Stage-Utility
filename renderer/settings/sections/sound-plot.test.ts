import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();
const { plottedMetric, readPlotChoice, writePlotChoice, peakLabel, usePlotPrefs, PLOT_STORAGE_KEY } = await import("./sound-plot.js");
const { renderHook, act, cleanup } = await import("@testing-library/react");
after(() => {
  cleanup();
  teardown();
});

const ALL = ["FS Peak", "LAeq 15", "LCeq", "SPL A Slow"];
const OLD = ["LAeq 15", "LCeq", "SPL A Slow"];

describe("plottedMetric", () => {
  test("this browser's own choice wins when the record carries it", () => {
    assert.deepEqual(plottedMetric(ALL, { chosen: "FS Peak", trends: "SPL A Slow" }), { metric: "FS Peak", wanted: null, trends: "SPL A Slow" });
  });

  test("with no choice it plots the Trends metric", () => {
    assert.deepEqual(plottedMetric(ALL, { chosen: null, trends: "SPL A Slow" }), { metric: "SPL A Slow", wanted: null, trends: "SPL A Slow" });
  });

  test("with neither saved, Trends' own default applies: LAeq 2, else LAeq 1, else the first", () => {
    assert.equal(plottedMetric(["LAeq 1", "LAeq 2", "X"], { chosen: null, trends: null })?.metric, "LAeq 2");
    assert.equal(plottedMetric(["LAeq 1", "X"], { chosen: null, trends: null })?.metric, "LAeq 1");
    assert.equal(plottedMetric(["B", "A"], { chosen: null, trends: null })?.metric, "B", "the first recorded, in the order given");
  });

  test("a choice this record lacks falls back to the Trends metric and names what it wanted", () => {
    assert.deepEqual(plottedMetric(OLD, { chosen: "FS Peak", trends: "SPL A Slow" }), { metric: "SPL A Slow", wanted: "FS Peak", trends: "SPL A Slow" });
  });

  test("a Trends metric this record lacks falls back to the first recorded and says so", () => {
    assert.deepEqual(plottedMetric(OLD, { chosen: null, trends: "FS Peak" }), { metric: "LAeq 15", wanted: "FS Peak", trends: "FS Peak" });
  });

  test("neither the choice nor Trends recorded: the first recorded, wanting the choice", () => {
    assert.deepEqual(plottedMetric(["LCeq", "SPL A Slow"], { chosen: "FS Peak", trends: "LAeq 2" }), { metric: "LCeq", wanted: "FS Peak", trends: "LAeq 2" });
  });

  test("a record with no metric plots nothing", () => {
    assert.equal(plottedMetric([], { chosen: "FS Peak", trends: "LAeq 2" }), null);
  });
});

describe("the stored choice", () => {
  beforeEach(() => localStorage.clear());

  test("reads what was written, and null once cleared", () => {
    assert.equal(readPlotChoice(), null);
    assert.equal(writePlotChoice("FS Peak"), null);
    assert.equal(readPlotChoice(), "FS Peak");
    assert.deepEqual(JSON.parse(localStorage.getItem(PLOT_STORAGE_KEY)!), ["FS Peak"], "a one-key list, like every other Customize preference");
    assert.equal(writePlotChoice(null), null);
    assert.equal(readPlotChoice(), null);
  });

  test("an unreadable or non-list value is no choice", () => {
    localStorage.setItem(PLOT_STORAGE_KEY, "{not json");
    assert.equal(readPlotChoice(), null);
    localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify("FS Peak"));
    assert.equal(readPlotChoice(), null);
    localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify([""]));
    assert.equal(readPlotChoice(), null, "an empty name is no choice");
  });

  test("plottedMetric follows the preferences it is given, and ignores the table columns entirely", () => {
    localStorage.setItem("spl:visibleMetrics", JSON.stringify(["LCeq"]));
    assert.equal(plottedMetric(ALL, { trends: "SPL A Slow", chosen: readPlotChoice() })?.metric, "SPL A Slow", "a ticked column is not a plot choice");
    writePlotChoice("FS Peak");
    assert.equal(plottedMetric(ALL, { trends: "SPL A Slow", chosen: readPlotChoice() })?.metric, "FS Peak");
  });

  /** Make every localStorage write throw, as private mode or a full quota does,
   *  until the test ends. Returns the way to let writes through again early. */
  function refuseWrites(t: { after: (fn: () => void) => void }): () => void {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const realSet = proto.setItem;
    proto.setItem = () => {
      throw new Error("quota exceeded");
    };
    const allow = () => void (proto.setItem = realSet);
    t.after(() => {
      allow();
      cleanup();
      // A held choice outlives the test otherwise, and shadows the next one's storage.
      writePlotChoice(null);
    });
    return allow;
  }

  test("a choice the browser will not store still changes the plot for the page, and the failure is returned", (t) => {
    const allow = refuseWrites(t);
    const { result } = renderHook(() => usePlotPrefs("SPL A Slow"));
    let failure: Error | null = null;
    act(() => void (failure = writePlotChoice("LCeq")));
    assert.match((failure as Error | null)?.message ?? "", /quota exceeded/);
    assert.equal(result.current.chosen, "LCeq", "a refused write left the plot where it was");
    // Back to Trends while storage holds nothing newer: a held null, not "nothing held".
    act(() => void writePlotChoice(null));
    assert.equal(result.current.chosen, null);
    // The next write that lands is newer than anything held.
    allow();
    act(() => void writePlotChoice("FS Peak"));
    assert.equal(result.current.chosen, "FS Peak");
  });

  test("another tab's choice reaches this one", (t) => {
    t.after(() => cleanup());
    const { result } = renderHook(() => usePlotPrefs("SPL A Slow"));
    assert.equal(result.current.chosen, null);
    // What the other tab's write leaves in storage, and the event this tab gets for it.
    localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify(["FS Peak"]));
    act(() => void window.dispatchEvent(new window.StorageEvent("storage", { key: PLOT_STORAGE_KEY })));
    assert.equal(result.current.chosen, "FS Peak", "another tab's choice did not reach this one");
    // An unrelated key is not a change to the plot.
    localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify(["LCeq"]));
    act(() => void window.dispatchEvent(new window.StorageEvent("storage", { key: "spl:visibleFigures" })));
    assert.equal(result.current.chosen, "FS Peak");
  });

  test("and replaces one this tab is holding because it could not store it", (t) => {
    const allow = refuseWrites(t);
    const { result } = renderHook(() => usePlotPrefs("SPL A Slow"));
    act(() => void writePlotChoice("LCeq"));
    allow();
    localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify(["FS Peak"]));
    assert.equal(result.current.chosen, "LCeq", "sanity: the held choice shadows storage until something newer arrives");
    act(() => void window.dispatchEvent(new window.StorageEvent("storage", { key: PLOT_STORAGE_KEY })));
    assert.equal(result.current.chosen, "FS Peak");
  });
});

describe("labels", () => {
  test("never double Peak, before or after", () => {
    assert.equal(peakLabel("FS Peak", "suffix"), "FS Peak");
    assert.equal(peakLabel("SPL A Slow", "suffix"), "SPL A Slow peak");
    assert.equal(peakLabel("FS Peak", "prefix"), "FS Peak");
    assert.equal(peakLabel("SPL A Slow", "prefix"), "Peak SPL A Slow");
  });
});
