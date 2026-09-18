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
// Driven through the real component and the real api.ts, asserting on what is
// POSTed, because the bug is entirely in what gets sent — the UI redraws from
// the same wrong list either way and looks self-consistent.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its message, and inspecting a live jsdom element does not
// terminate in any useful time.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act, fireEvent, within } = await import("@testing-library/react");
const React = await import("react");
const { SplDetail } = await import("./spl-history-section.js");

async function flushReact(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

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


test("unticking a default metric removes THAT one, on a store with nothing in it", async () => {
  const realFetch = globalThis.fetch;
  const saved: string[][] = [];
  globalThis.fetch = (async (_input: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      saved.push(JSON.parse(init.body ?? "{}").metrics);
      return { ok: true, status: 200, json: async () => ({ metrics: [] }) };
    }
    // Nothing stored: the section falls back to defaultVisible(), which is the
    // state the bug lived in.
    return { ok: true, status: 200, json: async () => ({ metrics: [] }) };
  }) as unknown as typeof fetch;

  try {
    render(
      React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
        detail: DETAIL,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

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

    // The one saved list is the OTHER default, alone. On the bug this was
    // ["SPL A Fast"] — the metric just unticked, and nothing else.
    assert.deepEqual(saved, [["LAeq 1"]], `saved ${JSON.stringify(saved)}`);

    cleanup();
    await flushReact();
  } finally {
    globalThis.fetch = realFetch;
  }
});
