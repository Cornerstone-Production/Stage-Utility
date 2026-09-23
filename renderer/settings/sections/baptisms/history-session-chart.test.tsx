// history-session-chart.test.tsx — Task 18's read-only entry point onto the
// Session chart: HistorySessionChart, on a PAST service's own serviceKey plus
// its linked sessions, never the live BaptismState SessionChart takes.
//
// Driven through the real component with a stubbed fetch, the same shape
// session-chart.test.tsx uses for the live chart's own three honest states —
// this proves the past-service ones: one session draws its chart and its
// people splits inline; two sessions (a reset and restart, or two sessions
// genuinely recorded in one service) both draw, each on its own window; a
// session with no raw rows in the shared lane — keyless (matched by time
// overlap) or keyed but predating the raw layer — gets its splits and one
// plain line, never a chart that reads as nothing happened.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see
// baptism-operator-armed.test.tsx's note on why.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installRenderDom();

const { render, screen, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { HistorySessionChart } = await import("./session-chart.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const KEY = "st1:plan1:history-chart";

function session(overrides: Partial<BaptismSession> = {}): BaptismSession {
  return {
    id: "b1",
    startedAt: "2026-09-20T15:00:00.000Z",
    finishedAt: "2026-09-20T15:10:00.000Z",
    title: "Sunday Gathering",
    serviceTypeId: "st1",
    planId: "plan1",
    serviceKey: KEY,
    people: [{ testimonyMs: 120_000, baptizeMs: 60_000 }],
    ...overrides,
  };
}

function stubFetch(lane: { spans: unknown[] }) {
  return (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (url.includes("/api/baptism/lane")) return ok(lane);
    if (url.includes("/api/service-timeline/")) return ok({ items: [] });
    return ok({});
  }) as unknown as typeof fetch;
}

async function mount(sessions: BaptismSession[], lane: { spans: unknown[] } = { spans: [] }): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(lane);
  try {
    render(React.createElement(HistorySessionChart, { serviceKey: KEY, sessions }));
    await settle();
    await settle();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const chartCount = () => screen.queryAllByRole("img", { name: /Baptism session timeline/i }).length;
/** People tables render as plain <table> elements with no distinguishing
 *  role of their own — counted directly rather than through screen's
 *  text queries, which also match the SAME "Person N" label the chart's own
 *  SVG draws inside wide-enough segments (laneLabel), and would otherwise
 *  throw on "multiple elements found" for the very case being proven. */
const tableCount = () => document.querySelectorAll("table").length;
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

test("one linked session with spans draws its chart and its per-person splits inline", async () => {
  await mount(
    [session()],
    {
      spans: [
        { kind: "testimony", person: 1, startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T15:02:00.000Z" },
        { kind: "baptism", person: 1, startedAt: "2026-09-20T15:09:00.000Z", endedAt: "2026-09-20T15:10:00.000Z" },
      ],
    },
  );

  assert.equal(chartCount(), 1, "expected exactly one chart for one session");
  assert.equal(!!screen.queryByText(/No timing detail was recorded/i), false, "a session with spans must not show the empty note");
  assert.equal(tableCount(), 1, "expected one per-person split table inline");
  assert.match(text(document.querySelector("table")), /Person 1/);
  assert.match(text(document.querySelector("table")), /Testimony/);
});

// The controller notes' own example: a reset-and-restart, or two sessions
// genuinely recorded in one service. The lane endpoint already returns every
// session's spans concatenated (see sessionSpans' own comment) — this proves
// TWO past sessions here each get their OWN chart from that one shared fetch.
test("a service whose baptism.csv holds two sessions draws both, each on its own window", async () => {
  const first = session({
    id: "b1",
    startedAt: "2026-09-20T15:00:00.000Z",
    finishedAt: "2026-09-20T15:05:00.000Z",
    people: [{ testimonyMs: 60_000, baptizeMs: 30_000 }],
  });
  const second = session({
    id: "b2",
    startedAt: "2026-09-20T15:20:00.000Z",
    finishedAt: "2026-09-20T15:25:00.000Z",
    people: [{ testimonyMs: 45_000, baptizeMs: 20_000 }],
  });
  await mount(
    [first, second],
    {
      spans: [
        { kind: "testimony", person: 1, startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T15:01:00.000Z" },
        { kind: "baptism", person: 1, startedAt: "2026-09-20T15:04:00.000Z", endedAt: "2026-09-20T15:05:00.000Z" },
        { kind: "testimony", person: 1, startedAt: "2026-09-20T15:20:00.000Z", endedAt: "2026-09-20T15:20:45.000Z" },
        { kind: "baptism", person: 1, startedAt: "2026-09-20T15:24:40.000Z", endedAt: "2026-09-20T15:25:00.000Z" },
      ],
    },
  );

  assert.equal(chartCount(), 2, "both sessions' spans are in the one shared lane fetch — both must draw");
  // Two people tables, one per session — each session's own splits, not one
  // combined table that loses which figures belong to which session.
  assert.equal(tableCount(), 2, "expected one People table per session");
});

test("a KEYED session with no spans in the shared lane (recorded before the raw layer) gets its splits and a plain 'no timeline' line, never an empty chart", async () => {
  await mount([session()], { spans: [] });

  assert.equal(chartCount(), 0, "no spans for this session's own window — must not draw an empty chart");
  assert.equal(!!screen.queryByText(/No timing detail was recorded for this session/i), true);
  assert.equal(tableCount(), 1, "the splits must still show even with no timeline");
  assert.match(text(document.querySelector("table")), /Person 1/);
});

test("a KEYLESS session (matched by time overlap) always gets the 'no timeline' note, even if unrelated spans exist in this service's lane", async () => {
  // A span that would, by pure time-overlap coincidence, fall inside this
  // session's own window — proving the keyless branch never even attempts to
  // read it, since a keyless session (linkBaptisms' own time-overlap match)
  // by construction never ran under THIS service's key at all.
  await mount(
    [session({ serviceKey: null, startedAt: "2026-09-20T16:00:00.000Z", finishedAt: "2026-09-20T16:05:00.000Z" })],
    {
      spans: [
        { kind: "testimony", person: 1, startedAt: "2026-09-20T16:01:00.000Z", endedAt: "2026-09-20T16:02:00.000Z" },
      ],
    },
  );

  assert.equal(chartCount(), 0, "a keyless session must never draw a chart from another key's raw rows");
  assert.equal(!!screen.queryByText(/No timing detail was recorded for this session/i), true);
});

test("a load failure shows its own error note, distinct from 'no timeline was recorded'", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    if (url.includes("/api/log/client")) return ok({});
    if (url.includes("/api/baptism/lane")) throw new Error("network down");
    if (url.includes("/api/service-timeline/")) return ok({ items: [] });
    void init;
    return ok({});
  }) as unknown as typeof fetch;
  try {
    render(React.createElement(HistorySessionChart, { serviceKey: KEY, sessions: [session()] }));
    await settle();
    await settle();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(!!screen.queryByText(/Couldn't load the timing lane/i), true, "expected the fetch-failure note");
  assert.equal(!!screen.queryByText(/No timing detail was recorded/i), false, "a fetch failure must not read as a session that recorded nothing");
});
