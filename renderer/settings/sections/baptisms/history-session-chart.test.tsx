// history-session-chart.test.tsx — the read-only entry point onto the
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
const { formatClock, setDisplayHourCycle } = await import("../../../lib/clock-format.js");

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

// The two ways a service ends up with more than one session: a reset-and-
// restart, or two sessions genuinely recorded in one service. The lane
// endpoint already returns every session's spans concatenated (see
// sessionSpans' own comment) — this proves each past session here draws from
// its own slice of that one shared fetch, never the whole thing.
test("a service whose baptism.csv holds two sessions draws both, each on its own window", async (t) => {
  setDisplayHourCycle("24h");
  t.after(() => setDisplayHourCycle(null));
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
  // A third, KEYED session with NO spans of its own anywhere in the lane —
  // this is what actually catches a "whole lane" draw: the other two
  // sessions' spans both fall outside ITS OWN window, so the chart's own
  // geometry hides them as not-visible either way (see laneSegments' own
  // domain check) and a plain rect count cannot tell "correctly empty" from
  // "wrongly handed the whole lane, then geometrically masked" apart. Only
  // `hasChart`/the EmptyNote can: a whole-lane draw makes `sessionOnlySpans`
  // non-empty for THIS session too, so it would draw an empty-looking chart
  // instead of the correct "no timing detail" note.
  const third = session({
    id: "b3",
    startedAt: "2026-09-20T15:40:00.000Z",
    finishedAt: "2026-09-20T15:41:00.000Z",
    people: [{ testimonyMs: 30_000, baptizeMs: 15_000 }],
  });
  await mount(
    [first, second, third],
    {
      spans: [
        { kind: "testimony", person: 1, startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T15:01:00.000Z" },
        { kind: "baptism", person: 1, startedAt: "2026-09-20T15:04:00.000Z", endedAt: "2026-09-20T15:05:00.000Z" },
        { kind: "testimony", person: 1, startedAt: "2026-09-20T15:20:00.000Z", endedAt: "2026-09-20T15:20:45.000Z" },
        { kind: "baptism", person: 1, startedAt: "2026-09-20T15:24:40.000Z", endedAt: "2026-09-20T15:25:00.000Z" },
      ],
    },
  );

  assert.equal(chartCount(), 2, "only the two sessions with spans of their OWN must draw a chart");
  assert.equal(
    !!screen.queryByText(/No timing detail was recorded for this session/i),
    true,
    "the third, keyed session with no spans of its own must get the empty note, never an empty-looking chart",
  );
  // Three people tables, one per session — each session's own splits, not one
  // combined table that loses which figures belong to which session.
  assert.equal(tableCount(), 3, "expected one People table per session");

  // Each chart must draw ONLY its own session's spans, never the whole
  // shared lane — a span's own startedAt is encoded straight into its
  // segment's own data-timer-segment id (session-lane.ts's timerLaneItems),
  // so this reads what actually landed in each chart's own SVG rather than
  // trusting a rect count alone, which a whole-lane draw could coincidentally
  // still match if a fixture's two sessions carried the same span count.
  const svgs = screen.queryAllByRole("img", { name: /Baptism session timeline/i });
  assert.equal(svgs.length, 2);
  function segmentTimes(svg: Element): string[] {
    return [...svg.querySelectorAll("[data-timer-segment]")]
      .map((g) => g.getAttribute("data-timer-segment") ?? "")
      .map((id) => id.replace(/^(?:testimony|baptism)-\d+-/, ""))
      .sort();
  }
  assert.deepEqual(
    segmentTimes(svgs[0]!),
    ["2026-09-20T15:00:00.000Z", "2026-09-20T15:04:00.000Z"].sort(),
    "session 1's own chart must show only session 1's own spans, not session 2's",
  );
  assert.deepEqual(
    segmentTimes(svgs[1]!),
    ["2026-09-20T15:20:00.000Z", "2026-09-20T15:24:40.000Z"].sort(),
    "session 2's own chart must show only session 2's own spans, not session 1's",
  );

  // Each People table must carry its OWN session's testimony, never the
  // first session's repeated under every one. The Testimony cell itself
  // (people-table.tsx's own column order: #, Person, Testimony, ...), not
  // the table's whole flattened text — jsdom concatenates "Person 1" and
  // "1:00" with no whitespace between them, so a bare substring match on
  // the whole table would read "11:00" and could not tell "1:00" from a
  // coincidental digit run inside a different value.
  const tables = [...document.querySelectorAll("table")];
  const testimonyCell = (tbl: Element) => text(tbl.querySelector("tbody tr td:nth-child(3)"));
  assert.equal(testimonyCell(tables[0]!), "1:00", "session 1's own testimony (60s)");
  assert.equal(testimonyCell(tables[1]!), "0:45", "session 2's own testimony (45s)");

  // Each session's own "Session · <time>" header, in the app's own clock
  // format (formatClock, 24h here) rather than the browser's raw locale —
  // see session-chart.tsx's own comment on why toLocaleTimeString is the
  // wrong call.
  const headers = [...document.querySelectorAll("span")].filter((el) => (el.textContent ?? "").startsWith("Session ·"));
  assert.equal(headers.length, 3, "expected one 'Session ·' header per session");
  assert.equal(text(headers[0]!), `Session · ${formatClock(first.startedAt)}`);
  assert.equal(text(headers[1]!), `Session · ${formatClock(second.startedAt)}`);
  assert.equal(text(headers[2]!), `Session · ${formatClock(third.startedAt)}`);
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

// Same bug, same fix, as session-chart.test.tsx's own "the chart re-lays out
// when its host resizes" test: useSessionLane's own fetch never resolves
// synchronously, so `loaded` is false on the FIRST render and only becomes
// true once it settles. The host div must render — and be observed —
// regardless: if the ResizeObserver effect's own ref instead lived on
// content gated behind `loaded` (an early `return null` before ANY div
// exists), the effect would fire once against `hostRef.current === null`
// and never get a second chance, since its deps are `[]` — the observer
// would never attach to anything, and the chart would be stuck at its
// 640px default forever, regardless of the card's own real width. This
// proves the opposite: the SAME host is observed from the very first
// render, before the lane even resolves, and is still that same element
// once the chart draws inside it — nothing swapped the div out from under
// the observer partway through.
test("the host is observed from the very first render, before the lane even loads, and is still the same element once the chart draws inside it", async () => {
  let observed: Element | null = null;
  const realRO = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor() {}
    observe(el: Element) {
      observed = el;
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  const realFetch = globalThis.fetch;
  // A fetch that resolves on a LATER microtask/macrotask, never synchronously
  // — exactly what the real invoke()/apiFetch() path always does — so the
  // component's FIRST render genuinely has `loaded === false`.
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => "" });
    await new Promise((r) => setTimeout(r, 0));
    if (url.includes("/api/baptism/lane")) {
      return ok({
        spans: [
          { kind: "testimony", person: 1, startedAt: "2026-09-20T15:00:00.000Z", endedAt: "2026-09-20T15:02:00.000Z" },
        ],
      });
    }
    if (url.includes("/api/service-timeline/")) return ok({ items: [] });
    return ok({});
  }) as unknown as typeof fetch;
  try {
    render(React.createElement(HistorySessionChart, { serviceKey: KEY, sessions: [session()] }));
    // The FIRST render, before any fetch has resolved: `loaded` is false,
    // yet the host div already exists and is already being watched.
    assert.ok(observed, "expected the host to be observed on the very first render, not stranded until content exists inside it");
    const observedBeforeLoad = observed;

    await settle();
    await settle();
    await settle();

    assert.equal(chartCount(), 1, "sanity: the chart drew once the lane loaded");
    assert.equal(observed, observedBeforeLoad, "expected the SAME host element throughout — nothing swapped the observed div once the chart appeared inside it");
  } finally {
    globalThis.fetch = realFetch;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
  }
});
