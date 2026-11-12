// The Sound card's Plot choice, driven through the real SplDetail (with the
// page's plot preferences, see test-fixtures/spl-detail.tsx) and the real
// Customize popover with a fetch routed by URL.
//
// What is NOT here: where the title and the chart sit, and how the popover looks at
// 390px. jsdom loads no stylesheet and measures every box as 0, so those were
// driven in a browser instead.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see spl-metric-toggle.test.tsx.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { eventually, installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { SplDetailOnPage } = await import("../../test-fixtures/spl-detail.js");

const T0 = Date.parse("2026-09-17T20:15:00.000Z");
const MIN = 60_000;
const ALL = ["FS Peak", "LAeq 15", "LCeq", "SPL A Slow"];

function recordOf(metrics: string[]): ServiceSplHistory {
  const stat = { max: 96, avg: null, leq: 88, count: 500 };
  return {
    serviceKey: "1:2:3",
    serviceTypeId: "1",
    planId: "2",
    planTitle: "Night of Worship",
    seriesTitle: null,
    serviceDate: "2026-09-17",
    serviceTimeId: "3",
    serviceTimeStartsAt: new Date(T0).toISOString(),
    meterId: "m1",
    metricKey: metrics[0],
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 60 * MIN).toISOString(),
    items: [
      {
        itemId: "a",
        title: "MESSAGE",
        sequence: 0,
        metrics: Object.fromEntries(metrics.map((m, i) => [m, { ...stat, max: 100 - i * 3 }])),
        maxSpl: 100,
        leqSpl: 88,
        sampleCount: 500,
        startedAt: new Date(T0).toISOString(),
        endedAt: new Date(T0 + 30 * MIN).toISOString(),
      },
    ],
  } as unknown as ServiceSplHistory;
}

/** A fetch answering the series route with a raw line, and remembering which
 *  metric each request named. */
function seriesFetch() {
  const metrics: string[] = [];
  const f = (async (input: string) => {
    const url = String(input);
    if (!url.includes("/series")) return { ok: true, status: 200, json: async () => ({ metrics: [] }) };
    const metric = new URL(url, "http://x").searchParams.get("metric") ?? "";
    metrics.push(metric);
    const body = {
      metric,
      metrics: ALL,
      bucketSec: 5,
      buckets: Array.from({ length: 6 }, (_, i) => ({ t: T0 + i * MIN, max: 80 + i, avg: 76 + i })),
    };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  return { f, metrics };
}

let net: ReturnType<typeof seriesFetch>;
let realFetch: typeof fetch;
beforeEach(() => {
  localStorage.clear();
  realFetch = globalThis.fetch;
  net = seriesFetch();
  globalThis.fetch = net.f;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
after(async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  teardown();
});

async function mount(detail: ServiceSplHistory, trendsMetric: string | null = "SPL A Slow") {
  render(
    React.createElement(SplDetailOnPage as unknown as React.FunctionComponent<Record<string, unknown>>, { detail, trendsMetric }),
  );
  await eventually(() => assert.ok(document.querySelector("[data-series-line]"), "the raw line never drew"));
}

/** The open popover, opening it first when it is closed. */
function popover() {
  if (!screen.queryByRole("dialog")) fireEvent.click(screen.getByLabelText("Customize sound"));
  return screen.getByLabelText("Customize sound", { selector: "[role='dialog']" });
}
const group = (id: string) =>
  within(popover().querySelector(`[data-customize-group='${id}']`) as HTMLElement);
const stripLabels = () =>
  [...document.querySelectorAll("[data-history-strip] > div")].map((d) => (d.children[0]?.textContent ?? "").trim());
const settle = () => act(async () => void (await Promise.resolve()));
/** What the browser stored for the plot: a one-key list, [] once forgotten, null never written. */
const storedPlot = (): unknown => JSON.parse(localStorage.getItem("spl:plotMetric") ?? "null");

describe("what is plotted", () => {
  test("a fresh browser plots the Trends metric", async () => {
    await mount(recordOf(ALL));
    assert.deepEqual(net.metrics, ["SPL A Slow"]);
    assert.ok(stripLabels().includes("SPL A Slow peak"), stripLabels().join(" | "));
    assert.equal(group("plot").getByRole("radio", { name: /SPL A Slow/ }).getAttribute("aria-checked"), "true");
    assert.ok(!document.querySelector("[data-plot-fallback]"));
    popover();
    assert.ok(!document.querySelector("[data-plot-override]"), "an override line with nothing overridden");
  });

  test("picking a Plot radio re-reads the series for that metric and relabels the figures", async () => {
    await mount(recordOf(ALL));
    fireEvent.click(group("plot").getByRole("radio", { name: /LCeq/ }));
    await settle();
    await eventually(() => assert.deepEqual(net.metrics, ["SPL A Slow", "LCeq"]));
    assert.ok(stripLabels().includes("LCeq peak"), stripLabels().join(" | "));
    assert.deepEqual(storedPlot(), ["LCeq"]);
  });

  test("a metric that already says Peak is not called Peak twice", async () => {
    await mount(recordOf(ALL));
    fireEvent.click(group("plot").getByRole("radio", { name: /FS Peak/ }));
    await settle();
    await eventually(() => assert.ok(stripLabels().includes("FS Peak"), stripLabels().join(" | ")));
    assert.ok(!stripLabels().some((l) => /peak.*peak/i.test(l)), stripLabels().join(" | "));
    assert.ok(screen.queryAllByText("FS Peak peak").length === 0);
  });

  test("unticking a Table column neither re-reads the series nor changes what is plotted", async () => {
    await mount(recordOf(ALL));
    const before = net.metrics.length;
    const col = group("metrics").getByText("SPL A Slow").closest("label")!;
    fireEvent.click(within(col as HTMLElement).getByRole("checkbox"));
    await settle();
    assert.equal(net.metrics.length, before, "a column click re-read the series");
    assert.ok(stripLabels().includes("SPL A Slow peak"));
    assert.equal(storedPlot(), null, "a column click wrote a plot choice");
    // And the other way: the plotted metric can be one the table does not show.
    assert.equal(group("plot").getByRole("radio", { name: /SPL A Slow/ }).getAttribute("aria-checked"), "true");
  });

  test("the Trends metric carries the tag, and picking it forgets the override", async () => {
    await mount(recordOf(ALL));
    assert.ok(group("plot").getByText("Trends"), "the Trends metric is not tagged");
    fireEvent.click(group("plot").getByRole("radio", { name: /LCeq/ }));
    await settle();
    assert.ok(document.querySelector("[data-plot-override]"), "no reset line once overridden");
    fireEvent.click(group("plot").getByRole("radio", { name: /SPL A Slow/ }));
    await settle();
    assert.deepEqual(storedPlot(), [], "picking the Trends metric kept an override");
    assert.ok(!document.querySelector("[data-plot-override]"));
  });

  test("Use the Trends metric resets, and the line names what Trends plots", async () => {
    localStorage.setItem("spl:plotMetric", JSON.stringify(["FS Peak"]));
    await mount(recordOf(ALL));
    assert.deepEqual(net.metrics, ["FS Peak"]);
    popover();
    const line = document.querySelector("[data-plot-override]");
    assert.ok(line && /Trends plots SPL A Slow for everyone/.test(line.textContent ?? ""), line?.textContent ?? "no line");
    fireEvent.click(screen.getByText("Use the Trends metric"));
    await settle();
    await eventually(() => assert.deepEqual(net.metrics, ["FS Peak", "SPL A Slow"]));
    assert.deepEqual(storedPlot(), []);
    assert.ok(!document.querySelector("[data-plot-override]"));
  });

  test("an older service that lacks the choice plots Trends and says so in one line", async () => {
    localStorage.setItem("spl:plotMetric", JSON.stringify(["FS Peak"]));
    await mount(recordOf(ALL.filter((m) => m !== "FS Peak")));
    assert.deepEqual(net.metrics, ["SPL A Slow"]);
    const line = document.querySelector("[data-plot-fallback]");
    assert.equal(line?.textContent, "FS Peak wasn’t recorded for this service, so it shows SPL A Slow.");
    // The Plot group offers only what this record carries.
    assert.equal(group("plot").queryAllByRole("radio").length, 3);
    // The stored choice survives for the next service that has it.
    assert.deepEqual(storedPlot(), ["FS Peak"]);
  });

  test("the Plot group is a radio group the keyboard can move through", async () => {
    await mount(recordOf(ALL));
    const radios = group("plot").getAllByRole("radio");
    assert.equal(radios.length, 4);
    assert.equal(group("plot").getAllByRole("radiogroup").length, 1);
    const on = group("plot").getByRole("radio", { name: /SPL A Slow/ });
    on.focus();
    fireEvent.keyDown(on, { key: "ArrowUp" });
    await settle();
    await eventually(() => assert.deepEqual(storedPlot(), ["LCeq"]));
  });
});

describe("a browser that will not store the choice", () => {
  test("still plots what was picked, re-reading the series, and says it could not remember it", async (t) => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const realSet = proto.setItem;
    t.after(async () => {
      proto.setItem = realSet;
      // The choice is held for the page; forget it so the next test starts clean.
      const { writePlotChoice } = await import("./sound-plot.js");
      writePlotChoice(null);
    });
    const { toast } = await import("../../components/ui/toast.js");
    const errors = mock.method(toast, "error");
    t.after(() => errors.mock.restore());
    await mount(recordOf(ALL));
    proto.setItem = () => {
      throw new Error("quota exceeded");
    };
    fireEvent.click(group("plot").getByRole("radio", { name: /LCeq/ }));
    await settle();
    await eventually(() => assert.deepEqual(net.metrics, ["SPL A Slow", "LCeq"]));
    assert.ok(stripLabels().includes("LCeq peak"), stripLabels().join(" | "));
    assert.equal(group("plot").getByRole("radio", { name: /LCeq/ }).getAttribute("aria-checked"), "true");
    assert.deepEqual(
      errors.mock.calls.map((c) => c.arguments[0]),
      ["Could not remember that choice: quota exceeded"],
      "the refused save was not reported",
    );
  });
});
