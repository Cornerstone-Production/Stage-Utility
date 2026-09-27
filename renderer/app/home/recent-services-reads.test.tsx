// recent-services-reads.test.tsx — Home's Recent services card, when History's
// reads fail.
//
// The card renders nothing until something has been recorded, and all three of
// its reads used to `.catch(() => set…([]))` — so a server that did not answer
// hid the card exactly as a church that had recorded nothing would. History's
// own copy of these reads was fixed for the same lie (see "Which of the three
// history loads FAILED" in service-history-section.tsx); this is the copy that
// fix did not reach.
//
// Driven through the real card with a stubbed fetch. NOTHING BELOW PASSES A DOM
// NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to build its failure
// message, and inspecting a live jsdom element does not finish in any useful
// time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { RecentServicesCard } = await import("./cards.js");
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

// The card's "Open History" is a router Link, which needs a router in context.
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
await router.load();

const WEEKENDS = ["2026-08-16", "2026-08-23", "2026-08-30"];
const ATTENDANCE = WEEKENDS.map((day, i) => ({
  serviceKey: `st-1:plan-${day}:${day}`,
  serviceTypeId: "st-1",
  serviceTypeName: "Weekend",
  planId: `plan-${day}`,
  planTitle: "Sample plan",
  seriesTitle: null,
  serviceDate: day,
  serviceTimeId: null,
  serviceTimeStartsAt: `${day}T15:00:00.000Z`,
  startedAt: `${day}T15:00:00.000Z`,
  endedAt: `${day}T16:30:00.000Z`,
  samples: [],
  attendanceBaseline: 0,
  totalAttendance: 200 + i * 10,
  peakAttendance: 200 + i * 10,
  peakOccupancy: 200 + i * 10,
  minOccupancy: 0,
  lastAttendance: 200 + i * 10,
  lastOccupancy: 200 + i * 10,
})) as ServiceAttendance[];

type Read = "timeline" | "attendance" | "spl";

function stubFetch(failing: Read[], attendance: ServiceAttendance[] = []) {
  return stubFetchWithLog((url) => {
    const read = (name: Read, json: unknown) => {
      if (failing.includes(name)) throw new TypeError("fetch failed");
      return ok(json);
    };
    if (url.includes("/api/service-timeline")) return read("timeline", []);
    if (url.includes("/api/attendance/history")) return read("attendance", attendance);
    if (url.includes("/api/spl/summary")) return read("spl", []);
    return ok({});
  });
}

const card = (showSpl: boolean) =>
  React.createElement(
    RouterContextProvider as never,
    { router },
    React.createElement(RecentServicesCard, {
      state: { serviceTypeId: "st-1", serviceTypeName: "Weekend" } as StageState,
      showSpl,
    }),
  );

async function mount(showSpl = true) {
  const view = render(card(showSpl));
  await settle();
  await settle();
  return view;
}

const loggedHistory = (logs: { tag: string; message: string }[], re: RegExp) =>
  logs.some((l) => l.tag === "history" && re.test(l.message));

test("history that could not be read shows the card saying so, rather than hiding it", async () => {
  const f = stubFetch(["timeline", "attendance"]);
  try {
    await mount();
    assert.equal(!!screen.queryByText("Open History"), true, "the card must not vanish as if nothing were recorded");
    assert.match(alerts(), /Couldn't load the service timings and the attendance history/i);
    assert.ok(loggedHistory(f.logs, /service timings/i), `expected a [history] line — got ${JSON.stringify(f.logs)}`);
    assert.ok(loggedHistory(f.logs, /attendance history/i), `expected a [history] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

// Each of the two reads the card hides on, failing ALONE: either one is enough
// to keep the card, so the hide condition needs both terms.
for (const [read, words] of [["timeline", "the service timings"], ["attendance", "the attendance history"]] as const) {
  test(`only ${words} failing still shows the card, and names it`, async () => {
    const f = stubFetch([read]);
    try {
      await mount();
      assert.equal(!!screen.queryByText("Open History"), true, "one failed read is enough to keep the card");
      assert.equal(alerts(), `Couldn't load ${words}.`);
    } finally {
      f.restore();
    }
  });
}

test("a sound summary that loads on a second try takes its note away", async () => {
  const failing: Read[] = ["spl"];
  const f = stubFetch(failing, ATTENDANCE);
  try {
    const view = await mount(true);
    assert.match(alerts(), /Couldn't load the sound summary/i);
    // The operator turns the SPL trend line off and on again; this time it reads.
    failing.length = 0;
    view.rerender(card(false));
    await settle();
    view.rerender(card(true));
    await settle();
    await settle();
    assert.equal(alerts(), "", "the read that failed has since succeeded");
  } finally {
    f.restore();
  }
});

test("a sound summary that could not be read is named on a card that has figures", async () => {
  const f = stubFetch(["spl"], ATTENDANCE);
  try {
    await mount();
    assert.equal(!!screen.queryByText("Peak"), true, "the attendance figures still draw");
    assert.match(alerts(), /Couldn't load the sound summary/i);
    assert.ok(loggedHistory(f.logs, /sound summary/i), `expected a [history] line — got ${JSON.stringify(f.logs)}`);
  } finally {
    f.restore();
  }
});

test("control: nothing recorded, and nothing failed, still renders no card at all", async () => {
  const f = stubFetch([]);
  try {
    const { container } = await mount();
    assert.equal(container.textContent, "", "an empty history keeps the card out of the way");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});

test("control: every read loads, the card draws its figures with no alert", async () => {
  const f = stubFetch([], ATTENDANCE);
  try {
    await mount();
    assert.equal(!!screen.queryByText("Peak"), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
