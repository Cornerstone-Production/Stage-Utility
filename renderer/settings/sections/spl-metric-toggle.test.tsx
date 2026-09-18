// Unticking a Smaart metric removes THAT metric, and only that one.
//
// The first click on a fresh install did the opposite of what it said. Nothing
// is stored until the operator picks, so the section shows `defaultVisible(...)`
// — usually two metrics, both visibly ticked. The toggle computed the next set
// from the empty STORED list instead of from that shown set, so the first click
// APPENDED: the unticked metric stayed, and the other default disappeared,
// because a one-entry stored list is no longer empty and the default stops
// applying.
//
// Driven through the real component, asserting on what is STORED, because the
// bug is entirely in what gets written — the UI redraws from the same wrong
// list either way and looks self-consistent.
//
// The choice is a per-browser preference now (`spl:visibleMetrics`), seeded
// once from the server setting it took over from. It used to be written
// server-wide, so one person clicking a legend entry changed what everyone saw.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its message, and inspecting a live jsdom element does not
// terminate in any useful time.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { SplDetail } = await import("./spl-history-section.js");

async function flushReact(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

const STORE = "spl:visibleMetrics";

beforeEach(() => localStorage.clear());
afterEach(cleanup);
after(async () => {
  cleanup();
  // The section fetches its series on mount; that promise settles after the
  // test has ended, and without draining it the callback runs once this file's
  // DOM has gone — which fails the FILE while every test in it passes.
  await flushReact();
  teardown();
});

const T0 = Date.parse("2026-09-17T20:15:00.000Z");

/** One item carrying two metrics, both of which `defaultVisible` picks: one
 *  matching /spl/i and one matching /laeq/i. */
const DETAIL = {
  serviceKey: "1:2:3",
  serviceTypeId: "1",
  planId: "2",
  planTitle: "Night of Worship",
  seriesTitle: null,
  serviceDate: "2026-09-17",
  serviceTimeId: "3",
  serviceTimeStartsAt: new Date(T0).toISOString(),
  meterId: "m1",
  metricKey: "SPL A Fast",
  startedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0 + 60 * 60_000).toISOString(),
  items: [
    {
      itemId: "message",
      title: "MESSAGE",
      sequence: 0,
      metrics: {
        "SPL A Fast": { max: 101, avg: null, leq: 90, count: 500 },
        "LAeq 1": { max: 94, avg: null, leq: 88, count: 500 },
      },
      maxSpl: 101,
      leqSpl: 90,
      sampleCount: 500,
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0 + 40 * 60_000).toISOString(),
    },
  ],
} as unknown as ServiceSplHistory;


/** Answers the two routes the section calls: the metric seed, and the series
 *  (404 — this record has no raw rows, so the per-item fallback draws). */
function stubFetch(serverMetrics: string[] = []): typeof fetch {
  const posted: { url: string; body: unknown }[] = [];
  const f = (async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(init.body ?? "{}") });
      return { ok: true, status: 200, json: async () => ({ metrics: [] }) };
    }
    if (url.includes("/series")) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({ metrics: serverMetrics }) };
  }) as unknown as typeof fetch;
  (f as unknown as { posted: typeof posted }).posted = posted;
  return f;
}

async function mount(detail: unknown = DETAIL): Promise<void> {
  render(
    React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, { detail }),
  );
  // Twice: the seed read resolves, then the render it causes settles.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const stored = () => JSON.parse(localStorage.getItem(STORE) ?? "null");

test("unticking a default metric removes THAT one, on a store with nothing in it", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
  try {
    await mount();

    // Both defaults are on screen, as columns of the per-item table.
    const table = within(screen.getByRole("table"));
    assert.equal(table.queryAllByText("SPL A Fast").length, 1);
    assert.equal(table.queryAllByText("LAeq 1").length, 1);

    fireEvent.click(screen.getByLabelText("Customize sound"));
    const popover = within(screen.getByLabelText("Customize sound", { selector: "[role='dialog']" }));
    fireEvent.click(popover.getByText("SPL A Fast"));
    await act(async () => {
      await Promise.resolve();
    });

    // The OTHER default, alone. On the bug this was ["SPL A Fast"] — the metric
    // just unticked, and nothing else.
    assert.deepEqual(stored(), ["LAeq 1"]);

    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the choice is written per browser, and nothing is POSTed to the server", async () => {
  // A legend click used to write settingsStore.splVisibleMetrics, which every
  // other browser in the building reads.
  const realFetch = globalThis.fetch;
  const f = stubFetch();
  globalThis.fetch = f;
  try {
    await mount();
    fireEvent.click(screen.getByLabelText("Customize sound"));
    const popover = within(screen.getByLabelText("Customize sound", { selector: "[role='dialog']" }));
    fireEvent.click(popover.getByText("SPL A Fast"));
    await act(async () => {
      await Promise.resolve();
    });

    assert.deepEqual(stored(), ["LAeq 1"]);
    assert.deepEqual(
      (f as unknown as { posted: { url: string }[] }).posted,
      [],
      "the section wrote a server-wide setting",
    );

    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a browser with no choice is SEEDED from the server setting, once", async () => {
  // Nobody loses the selection they had when the preference moved.
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(["LAeq 1"]);
  try {
    await mount();
    assert.deepEqual(stored(), ["LAeq 1"]);
    const table = within(screen.getByRole("table"));
    assert.equal(table.queryAllByText("LAeq 1").length, 1);
    assert.equal(table.queryAllByText("SPL A Fast").length, 0, "the seed did not take");
    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an EMPTY choice stays empty — it does not spring the defaults back", async () => {
  // Unticking the last metric is a real choice. Falling back to the defaults on
  // an empty list made it impossible to express, and the chart came back with
  // both metrics the moment the page was reopened.
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
  try {
    await mount();
    fireEvent.click(screen.getByLabelText("Customize sound"));
    const popover = within(screen.getByLabelText("Customize sound", { selector: "[role='dialog']" }));
    fireEvent.click(popover.getByText("SPL A Fast"));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(popover.getByText("LAeq 1"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.deepEqual(stored(), []);
    cleanup();
    await flushReact();

    // Reopened: still empty, and the chart says why rather than showing the
    // "nothing recorded yet" sentence, which would be false.
    await mount();
    assert.deepEqual(stored(), []);
    assert.equal(document.querySelectorAll("[data-series-line]").length, 0);
    // Two places say it: the empty plot and the strip. getByText would throw on
    // finding both, which is a pass reported as a failure.
    assert.ok(screen.queryAllByText(/No metric selected/).length >= 1, "the empty chart does not say why");
    const strip = document.querySelector("[data-history-strip]") as HTMLElement;
    assert.ok(strip.textContent?.includes("No metric selected"), strip.textContent ?? "");
    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the legend lists EVERY metric, so one that is off can come back", async () => {
  // The fallback built its series from the shown list with `on: true`, so a
  // metric switched off vanished from the legend entirely and the only way back
  // was Customize. Attendance has always listed the whole offering.
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
  try {
    await mount();
    const toggle = (id: string) => document.querySelector(`[data-series-toggle='${id}']`) as HTMLButtonElement;
    assert.equal(toggle("SPL A Fast").getAttribute("aria-pressed"), "true");
    assert.equal(toggle("LAeq 1").getAttribute("aria-pressed"), "true");

    fireEvent.click(toggle("SPL A Fast"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.ok(toggle("SPL A Fast"), "the off metric left the legend");
    assert.equal(toggle("SPL A Fast").getAttribute("aria-pressed"), "false");
    assert.equal(document.querySelectorAll("[data-series-line='SPL A Fast']").length, 0);

    // And back on, from the legend alone.
    fireEvent.click(toggle("SPL A Fast"));
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(toggle("SPL A Fast").getAttribute("aria-pressed"), "true");
    assert.ok(document.querySelectorAll("[data-series-line='SPL A Fast']").length > 0);
    assert.deepEqual(stored()?.slice().sort(), ["LAeq 1", "SPL A Fast"]);

    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});
