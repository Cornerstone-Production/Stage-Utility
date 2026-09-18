// A re-run item is TWO rows in the SPL detail table.
//
// The recorder now gives an item that runs a second time its own entry with its
// own max/Leq (main/services/spl-recorder.ts). The table keyed its rows by
// itemId alone, so the two entries shared a React key: every render of a service
// with a reprise logged "Encountered two children with the same key", and React
// is free to reuse the wrong row's state on the next render.
//
// Both halves are asserted. The row COUNT alone does not go red on the bug —
// React still renders both children of a duplicate key on a first render — so
// the warning is the half that proves the fix, and this suite runs React's
// development build, which is what emits it. The production bundle does not warn
// at all (both checked in a real Chrome against a real server), so the shipped
// cost is silent: two rows sharing an identity across re-renders.
//
// NOT unit-tested here, and driven in a real browser instead: how the table
// looks with two rows of the same name (jsdom loads no stylesheet, so nothing
// about the row striping or column alignment is observable). Done — a service
// with Doors run twice renders 104/101 dB and 78/74 dB on their own rows.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its message, and inspecting a live jsdom element does not
// terminate in any useful time.

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { SplDetail } = await import("./spl-history-section.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

const METRIC = "SPL A Slow";

function run(sequence: number, max: number, leq: number) {
  return {
    itemId: "doors",
    title: "Doors",
    itemType: "item",
    sequence,
    metrics: { [METRIC]: { max, avg: null, leq, count: 40 } },
    maxSpl: max,
    leqSpl: leq,
    sampleCount: 40,
    startedAt: "2026-09-18T23:23:46.000Z",
    endedAt: "2026-09-18T23:32:03.000Z",
  };
}

/** Two runs of one item, as the recorder writes them. */
const DETAIL = {
  serviceKey: "st1:plan:occ-1",
  serviceTypeId: "st1",
  serviceTypeName: "Sunday",
  planId: "plan",
  planTitle: "A Plan",
  seriesTitle: null,
  serviceDate: "2026-09-18",
  serviceTimeId: "occ-1",
  serviceTimeStartsAt: null,
  meterId: "m1",
  metricKey: METRIC,
  startedAt: "2026-09-18T23:23:46.000Z",
  endedAt: null,
  items: [run(0, 104, 101), run(1, 78, 74)],
};

test("two runs of one item are two rows, with no duplicate-key warning", async () => {
  // The metric picker asks the server which metrics to surface on mount.
  const beforeFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ metrics: [METRIC] }),
  })) as unknown as typeof fetch;
  const errors: string[] = [];
  const beforeError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  try {
    const r = render(
      React.createElement(SplDetail as unknown as React.FunctionComponent<Record<string, unknown>>, {
        detail: DETAIL,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    assert.equal(screen.queryAllByText("Doors").length, 2, "the two runs are not both on screen");
    assert.equal(screen.queryAllByText("104 dB").length, 1, "the first run's peak is missing");
    assert.equal(screen.queryAllByText("78 dB").length, 1, "the re-run's own peak is missing");
    assert.deepEqual(
      errors.filter((e) => e.includes("same key")),
      [],
      "the table keys its rows on an item id two runs share",
    );
    r.unmount();
  } finally {
    console.error = beforeError;
    globalThis.fetch = beforeFetch;
  }
});
