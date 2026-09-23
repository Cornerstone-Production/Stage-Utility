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

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { SessionChart } = await import("./session-chart.js");

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
