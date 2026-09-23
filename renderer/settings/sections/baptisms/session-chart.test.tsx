// session-chart.test.tsx — the Session card's three honest states: no session
// known at all, a session with no raw rows, and one with a lane to draw.
//
// Driven through the real component with a stubbed fetch, the same shape
// baptism-operator-armed.test.tsx uses — not a unit test of the branches in
// isolation, because what matters is what the OPERATOR sees on each of the
// three. The lane's own geometry (positions, labels, colours) is
// session-lane.test.ts's job; jsdom lays nothing out to check it against here.
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see
// baptism-operator-armed.test.tsx's note on why.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { SessionChart, SESSION_LANES_STORAGE_KEY } = await import("./session-chart.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const BASE: BaptismState = {
  mode: "grouped",
  phase: "idle",
  personNumber: 0,
  baptismIndex: 0,
  armed: false,
  segmentStartedAt: null,
  segmentAccumMs: 0,
  sessionStartedAt: null,
  finishedAt: null,
  people: [],
  pendingTestimonyMs: null,
  serviceTitle: null,
  serviceTypeId: null,
  planId: null,
};

function stubFetch(lane: { spans: unknown[] }) {
  return (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (url.includes("/api/baptism/lane")) return ok(lane);
    if (url.includes("/api/service-timeline/current")) return ok(null);
    if (url.includes("/api/service-timeline/")) return ok(null);
    return ok({});
  }) as unknown as typeof fetch;
}

async function mount(state: BaptismState, lane: { spans: unknown[] } = { spans: [] }): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(lane);
  try {
    render(React.createElement(SessionChart, { state }));
    await settle();
    await settle();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("no service open — no serviceKey at all — says so and draws nothing", async () => {
  await mount({ ...BASE, serviceKey: null });

  assert.equal(
    !!screen.queryByText(/No session recorded yet/i),
    true,
    "expected the 'no session' empty note",
  );
  assert.equal(!!screen.queryByRole("img", { name: /Baptism session timeline/i }), false, "must not draw an empty lane");
  // The card and its section-nav anchor exist regardless of emptiness.
  assert.equal(!!document.getElementById("s-session"), true, "expected the Session card's anchor id");
});

test("a session with no raw rows says timing detail is missing, not a blank chart", async () => {
  await mount(
    {
      ...BASE,
      serviceKey: "st1:plan1:no-rows",
      finishedAt: "2026-09-20T15:10:00.000Z",
      sessionStartedAt: "2026-09-20T15:00:00.000Z",
    },
    { spans: [] },
  );

  assert.equal(
    !!screen.queryByText(/No timing detail was recorded/i),
    true,
    "expected the 'no raw rows' empty note, distinct from 'no session'",
  );
  assert.equal(!!screen.queryByText(/No session recorded yet/i), false, "the two empty notes must not both show");
  assert.equal(!!screen.queryByRole("img", { name: /Baptism session timeline/i }), false);
});

test("a session with recorded spans draws the lane and its legend", async () => {
  await mount(
    {
      ...BASE,
      serviceKey: "st1:plan1:has-rows",
      finishedAt: "2026-09-20T15:10:00.000Z",
      sessionStartedAt: "2026-09-20T15:00:00.000Z",
      people: [{ testimonyMs: 108_000, baptizeMs: 42_000 }],
    },
    {
      spans: [
        { kind: "testimony", person: 1, startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T15:01:48.000Z" },
        { kind: "baptism", person: 1, startedAt: "2026-09-20T15:05:00.000Z", endedAt: "2026-09-20T15:05:42.000Z" },
      ],
    },
  );

  assert.equal(!!screen.queryByText(/No timing detail was recorded/i), false, "spans were recorded — must not say otherwise");
  assert.equal(!!screen.queryByText(/No session recorded yet/i), false);
  assert.equal(!!screen.queryByRole("img", { name: /Baptism session timeline/i }), true, "expected the lane's SVG");
  assert.equal(!!screen.queryByText("Testimony"), true, "expected the legend's Testimony entry");
  assert.equal(!!screen.queryByText("Baptism"), true, "expected the legend's Baptism entry");
  assert.equal(!!screen.queryByText("Plan item"), true, "expected the legend's Plan item entry");
});

// Final review, Important 1: the window used to be the WHOLE SERVICE's plan
// and spans, not the session's. Seeded with a realistic running order — a
// countdown before the session, a sermon and closing after it — and driven
// for real, the axis read 0m to 85m for a session that ran about 25m to 47m,
// with a "not counted" block covering the sermon and closing. Reproduced here
// structurally (element counts, not pixels — jsdom lays nothing out): the
// session-lane.test.ts unit tests (sessionWindow/clipToSession/sessionSpans)
// are what this shape's arithmetic is actually proven against.
test("plan items before and after the session are left off the chart, not just squeezed", async () => {
  const timeline: ServiceTimeline = {
    serviceKey: "st1:plan1:realistic",
    serviceTypeId: null,
    serviceTypeName: null,
    planId: null,
    planTitle: null,
    seriesTitle: null,
    serviceDate: "2026-09-20",
    serviceTimeId: null,
    serviceTimeStartsAt: null,
    startedAt: "2026-09-20T14:55:00.000Z",
    endedAt: "2026-09-20T16:31:00.000Z",
    items: [
      // Before the session (15:20-15:47) entirely — must not draw.
      { itemId: "i0", title: "Countdown", sequence: 0, plannedLengthSec: 1200, startedAt: "2026-09-20T14:55:00.000Z", endedAt: "2026-09-20T15:15:00.000Z", actualDurationSec: 1200, preService: false },
      // Overlapping the session — must draw, clipped where they straddle it.
      { itemId: "i1", title: "Baptism Stories", sequence: 1, plannedLengthSec: 720, startedAt: "2026-09-20T15:20:00.000Z", endedAt: "2026-09-20T15:32:00.000Z", actualDurationSec: 720, preService: false },
      { itemId: "i2", title: "Great Are You Lord", sequence: 2, plannedLengthSec: 480, startedAt: "2026-09-20T15:32:00.000Z", endedAt: "2026-09-20T15:40:00.000Z", actualDurationSec: 480, preService: false },
      { itemId: "i3", title: "O Praise The Name", sequence: 3, plannedLengthSec: 480, startedAt: "2026-09-20T15:40:00.000Z", endedAt: "2026-09-20T15:48:00.000Z", actualDurationSec: 480, preService: false },
      // After the session entirely — must not draw, and must not stretch the
      // axis or the trailing "not counted" gap out to cover them.
      { itemId: "i4", title: "Sermon", sequence: 4, plannedLengthSec: 2280, startedAt: "2026-09-20T15:48:00.000Z", endedAt: "2026-09-20T16:26:00.000Z", actualDurationSec: 2280, preService: false },
      { itemId: "i5", title: "Closing", sequence: 5, plannedLengthSec: 300, startedAt: "2026-09-20T16:26:00.000Z", endedAt: "2026-09-20T16:31:00.000Z", actualDurationSec: 300, preService: false },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (url.includes("/api/baptism/lane")) {
      return ok({
        spans: [
          { kind: "testimony", person: 1, startedAt: "2026-09-20T15:20:00.000Z", endedAt: "2026-09-20T15:26:00.000Z" },
          { kind: "testimony", person: 2, startedAt: "2026-09-20T15:26:00.000Z", endedAt: "2026-09-20T15:32:00.000Z" },
          { kind: "baptism", person: 1, startedAt: "2026-09-20T15:35:00.000Z", endedAt: "2026-09-20T15:40:00.000Z" },
          { kind: "baptism", person: 2, startedAt: "2026-09-20T15:40:00.000Z", endedAt: "2026-09-20T15:47:00.000Z" },
        ],
      });
    }
    if (url.includes("/api/service-timeline/current")) return ok(null);
    if (url.includes("/api/service-timeline/")) return ok(timeline);
    return ok({});
  }) as unknown as typeof fetch;

  try {
    render(
      React.createElement(SessionChart, {
        state: {
          ...BASE,
          serviceKey: "st1:plan1:realistic",
          sessionStartedAt: "2026-09-20T15:20:00.000Z",
          finishedAt: "2026-09-20T15:47:00.000Z",
        },
      }),
    );
    await settle();
    await settle();

    assert.equal(
      document.querySelectorAll("[data-plan-segment]").length,
      3,
      "only the 3 plan items overlapping the session should draw — Countdown, Sermon and Closing must not",
    );
    assert.equal(
      document.querySelectorAll("[data-gap]").length,
      1,
      "exactly the one real internal gap (15:32-15:35) — no trailing gap out to the sermon/closing",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Fix round 1 (from drive 2), the CUSTOMIZE finding: the mockup's Session
// card has a Customize control and the plan built this tab on History's own
// CustomizePopover/prefs mechanism, but the shipped card had neither — the
// plan lane always drew, with no way to turn it off.
test("Customize toggles the plan lane off, and the choice persists across a remount", async () => {
  localStorage.removeItem(SESSION_LANES_STORAGE_KEY);
  const timeline: ServiceTimeline = {
    serviceKey: "st1:plan1:has-plan",
    serviceTypeId: null,
    serviceTypeName: null,
    planId: null,
    planTitle: null,
    seriesTitle: null,
    serviceDate: "2026-09-20",
    serviceTimeId: null,
    serviceTimeStartsAt: null,
    startedAt: "2026-09-20T14:58:00.000Z",
    endedAt: "2026-09-20T15:06:00.000Z",
    items: [
      {
        itemId: "i1",
        title: "Baptism Stories",
        sequence: 0,
        plannedLengthSec: 300,
        startedAt: "2026-09-20T14:58:00.000Z",
        endedAt: "2026-09-20T15:06:00.000Z",
        actualDurationSec: 480,
        preService: false,
      },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (url.includes("/api/baptism/lane")) {
      return ok({
        spans: [
          { kind: "testimony", person: 1, startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T15:01:48.000Z" },
          { kind: "baptism", person: 1, startedAt: "2026-09-20T15:05:00.000Z", endedAt: "2026-09-20T15:05:42.000Z" },
        ],
      });
    }
    if (url.includes("/api/service-timeline/current")) return ok(null);
    if (url.includes("/api/service-timeline/")) return ok(timeline);
    return ok({});
  }) as unknown as typeof fetch;

  try {
    const state: BaptismState = {
      ...BASE,
      serviceKey: "st1:plan1:has-plan",
      finishedAt: "2026-09-20T15:10:00.000Z",
      sessionStartedAt: "2026-09-20T15:00:00.000Z",
      people: [{ testimonyMs: 108_000, baptizeMs: 42_000 }],
    };
    render(React.createElement(SessionChart, { state }));
    await settle();
    await settle();

    assert.equal(
      document.querySelectorAll("[data-plan-segment]").length > 0,
      true,
      "the plan lane draws by default (Plan items on)",
    );

    fireEvent.click(screen.getByLabelText("Customize the Session chart"));
    fireEvent.click(screen.getByText("Plan items"));
    await settle();

    assert.equal(
      document.querySelectorAll("[data-plan-segment]").length,
      0,
      "toggled off — the plan lane draws nothing",
    );

    cleanup();
    render(React.createElement(SessionChart, { state }));
    await settle();
    await settle();

    assert.equal(
      document.querySelectorAll("[data-plan-segment]").length,
      0,
      "the choice persisted across a remount, not just within the same mount",
    );
  } finally {
    globalThis.fetch = realFetch;
    localStorage.removeItem(SESSION_LANES_STORAGE_KEY);
  }
});

// Fix round 1, finding I2: a failed baptism:lane fetch used to set spans: []
// and log with a bare console.warn — so the operator saw "No timing detail
// was recorded for this session" (a claim about the SESSION) for what was
// actually a network blip or a server restart, with the real cause sitting
// in a devtools console nobody has open.
test("a failed lane fetch shows its own note, not 'no timing detail', and reaches the log", async () => {
  const logCalls: { tag: string; message: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/log/client")) {
      logCalls.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }
    if (url.includes("/api/baptism/lane")) throw new Error("network down");
    return { ok: true, status: 200, json: async () => null, text: async () => "" };
  }) as unknown as typeof fetch;

  try {
    render(
      React.createElement(SessionChart, {
        state: {
          ...BASE,
          serviceKey: "st1:plan1:fetch-fails",
          finishedAt: "2026-09-20T15:10:00.000Z",
          sessionStartedAt: "2026-09-20T15:00:00.000Z",
        },
      }),
    );
    await settle();
    await settle();

    assert.equal(!!screen.queryByText(/Couldn't load the timing lane/i), true, "expected the fetch-failure note");
    // This session is finished: no baptism:state push arrives until somebody
    // presses something, so nothing will retry the fetch by itself.
    assert.equal(
      !!screen.queryByText(/retrying|next update|next press/i),
      false,
      "a finished session's note must not promise a retry that no push will trigger",
    );
    assert.equal(!!screen.queryByText(/Reload the page to try again/i), true, "it says what does retry: a reload");
    assert.equal(
      !!screen.queryByText(/No timing detail was recorded/i),
      false,
      "a failed fetch must not read as a session that recorded nothing",
    );
    assert.equal(
      !!screen.queryByText(/No session recorded yet/i),
      false,
      "a failed fetch must not read as no session at all either",
    );
    assert.ok(
      logCalls.some((c) => c.tag === "baptism" && /session lane fetch failed/i.test(c.message)),
      `expected a logToServer("baptism", ...) call naming the lane fetch — got ${JSON.stringify(logCalls)}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed lane fetch on a live session says the next press tries again", async () => {
  // Live, every press pushes baptism:state and the lane refetches on each push
  // — session-chart-refetch.test.tsx proves that plumbing.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    if (String(input).includes("/api/baptism/lane")) throw new Error("network down");
    return { ok: true, status: 200, json: async () => null, text: async () => "" };
  }) as unknown as typeof fetch;
  try {
    render(
      React.createElement(SessionChart, {
        state: {
          ...BASE,
          phase: "testimony",
          personNumber: 1,
          serviceKey: "st1:plan1:fetch-fails-live",
          sessionStartedAt: "2026-09-20T15:00:00.000Z",
          segmentStartedAt: "2026-09-20T15:00:00.000Z",
        },
      }),
    );
    await settle();
    await settle();
    assert.equal(!!screen.queryByText(/tries again at the next press/i), true, "expected the live wording");
    assert.equal(!!screen.queryByText(/Reload the page/i), false, "a live session retries by itself; no reload needed");
  } finally {
    globalThis.fetch = realFetch;
  }
});
