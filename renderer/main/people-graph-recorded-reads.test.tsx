// people-graph-recorded-reads.test.tsx — the people graph's Recorded mode on a
// display, when a History read fails.
//
// Its three reads used to `.catch(() => [] / null)`, so a server that did not
// answer drew "no recorded data", which says the service recorded nothing. A
// failed curve read now says it could not load. A failed MARKERS read is only
// logged, on purpose: the curve still draws without them and says nothing
// false. That decision is only visible on a service with no curve, so the test
// that guards it uses one.
//
// Driven through ObjectContent, the path a display takes, with a stubbed fetch.
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — node:assert inspects
// `actual` to build its failure message, and inspecting a live jsdom element
// does not finish in any useful time.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom({ clientHeight: 300 });

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { makeRenderCtx } = await import("./test-render-ctx.js");
const { TooltipProvider } = await import("../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const KEY = "st-1:plan-1:t1";
const RECORD = {
  serviceKey: KEY,
  startedAt: "2026-09-20T15:00:00.000Z",
  endedAt: "2026-09-20T16:15:00.000Z",
  samples: [
    { t: "2026-09-20T15:05:00.000Z", attendance: 10, occupancy: 120 },
    { t: "2026-09-20T15:20:00.000Z", attendance: 90, occupancy: 400 },
    { t: "2026-09-20T15:40:00.000Z", attendance: 150, occupancy: 520 },
  ],
};

type Read = "list" | "curve" | "markers";

function stubFetch(failing: Read | null, record: unknown = RECORD) {
  return stubFetchWithLog((url) => {
    const read = (name: Read, json: unknown) => {
      if (failing === name) throw new TypeError("fetch failed");
      return ok(json);
    };
    if (url === "/api/attendance/history?summary=1") return read("list", [RECORD]);
    if (url.startsWith("/api/attendance/history/")) return read("curve", record);
    if (url.startsWith("/api/service-timeline/")) return read("markers", { items: [] });
    return ok(null);
  });
}

/** A recorded-mode graph with the kiosk toggle, which is the configuration that
 *  printed "no recorded data" for a failed read. */
async function mount(recordedServiceKey: string | null): Promise<void> {
  render(
    React.createElement(TooltipProvider, null, React.createElement(ObjectContent, {
      o: {
        id: "g1",
        x: 0,
        y: 0,
        w: 0.5,
        h: 0.5,
        z: 1,
        config: { type: "people-graph", source: "recorded", kioskToggle: true, recordedServiceKey },
        style: {},
      },
      ctx: makeRenderCtx({ interactive: true }),
    } as never)),
  );
  await settle();
  await settle();
  await settle();
}

const logged = (logs: { tag: string; message: string }[], re: RegExp) =>
  logs.some((l) => l.tag === "history" && re.test(l.message));

test("a failed curve read says so, not 'no recorded data'", async () => {
  const f = stubFetch("curve");
  try {
    await mount(KEY);
    assert.match(alerts(), /couldn't load the recorded service/i);
    assert.equal(!!screen.queryByText(/no recorded data/i), false, "the service recorded plenty; the read failed");
    assert.ok(logged(f.logs, /people graph/i), `expected a [history] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed list read under Most recent says so too", async () => {
  const f = stubFetch("list");
  try {
    await mount(null);
    assert.match(alerts(), /couldn't load the recorded service/i);
    assert.equal(!!screen.queryByText(/no recorded data/i), false);
    assert.ok(logged(f.logs, /recorded services/i), `expected a [history] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed markers read still draws the curve, and is logged rather than shown", async () => {
  const f = stubFetch("markers");
  try {
    await mount(KEY);
    assert.equal(alerts(), "", "without markers the curve is still true");
    assert.equal(!!screen.queryByText(/no recorded data/i), false, "the curve drew");
    assert.ok(logged(f.logs, /plan items/i), `expected a [history] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("a failed markers read never marks the curve failed: an empty service still says 'no recorded data'", async () => {
  const f = stubFetch("markers", { ...RECORD, samples: [] });
  try {
    await mount(KEY);
    assert.equal(!!screen.queryByText(/no recorded data/i), true, "the curve read succeeded and was empty");
    assert.equal(alerts(), "", "the markers are not what the display is about");
    assert.ok(logged(f.logs, /plan items/i), `expected a [history] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("control: a service with no samples says 'no recorded data', with no alert", async () => {
  const f = stubFetch(null, { ...RECORD, samples: [] });
  try {
    await mount(KEY);
    assert.equal(!!screen.queryByText(/no recorded data/i), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
