// History's day list reads timeline records only (`serviceTimeline:list`), but
// the attendance recorder opens ITS record an hour earlier — at the start of
// the pre-service arrival ramp (see attendance-recorder.ts) — with no timeline
// record to go with it until the first Planning Center item goes live. Before
// this test, that arrival window was invisible: today's service didn't appear
// in History at all until it actually started.
//
// Driven through the REAL renderer/lib/api.ts (fetch routed by URL, SSE via a
// fake EventSource) rather than a stub of invoke/onNotification — the same
// approach renderer/main/use-status-channel.test.tsx uses, and for the same
// reason: the union has to survive a REAL "service-timeline:history" push
// turning an attendance-only row into a normal one, and a stub would not
// exercise the replay/broadcast plumbing that does that.
//
// jsdom lays out nothing and loads no stylesheet, so nothing here asserts
// layout, size or color — only what rendered.

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A fake EventSource that hands the test its channel listeners to fire —
 *  copied from use-status-channel.test.tsx, the one other place that needs to
 *  deliver a REAL SSE push through api.ts rather than stub onNotification. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }
  close(): void {}
  push(channel: string, payload: unknown): void {
    for (const fn of this.listeners.get(channel) ?? []) {
      fn({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const TODAY = "2026-09-03";
const SERVICE_KEY = "weekend:plan-1:2026-09-03";

/** Six pre-service samples, occupancy climbing — the last one (42) is what the
 *  row/detail captions read. */
function preSamples() {
  const base = Date.parse(`${TODAY}T09:00:00Z`);
  return Array.from({ length: 6 }, (_, i) => ({
    t: new Date(base + i * 5 * 60_000).toISOString(),
    attendance: i * 8,
    occupancy: i * 8,
    phase: "pre" as const,
  })).map((s, i) => (i === 5 ? { ...s, occupancy: 42, attendance: 42 } : s));
}

function arrivingAttendance() {
  return {
    serviceKey: SERVICE_KEY,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: TODAY,
    serviceTimeId: "time-1",
    serviceTimeStartsAt: `${TODAY}T10:00:00Z`,
    startedAt: `${TODAY}T09:00:00Z`,
    serviceStartedAt: null,
    endedAt: null,
    samples: preSamples(),
    attendanceBaseline: 0,
    totalAttendance: 42,
    peakAttendance: 0,
    peakOccupancy: 0,
    minOccupancy: null,
    lastAttendance: 0,
    lastOccupancy: 0,
  };
}

/** Routes fetch by URL/method, the way a real server would answer these
 *  specific routes — everything else 404s, which is the point: a call to a
 *  route this file didn't expect should fail loudly, not fall through to a
 *  default `{}`. */
function installFetch(state: { list: unknown[]; attList: unknown[] }) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: string,
    init?: { method?: string },
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (url === "/api/service-timeline") return ok(state.list);
    if (url === "/api/attendance/history") return ok(state.attList);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/baptism/sessions") return ok([]);
    const tlGet = url.match(/^\/api\/service-timeline\/([^/]+)$/);
    if (tlGet) {
      const key = decodeURIComponent(tlGet[1]);
      const rec = state.list.find((t) => (t as { serviceKey: string }).serviceKey === key) ?? null;
      return ok(rec);
    }
    const attGet = url.match(/^\/api\/attendance\/history\/([^/]+)$/);
    if (attGet) {
      const key = decodeURIComponent(attGet[1]);
      const rec = state.attList.find((a) => (a as { serviceKey: string }).serviceKey === key) ?? null;
      return ok(rec);
    }
    const splGet = url.match(/^\/api\/spl\/history\/([^/]+)$/);
    if (splGet) return ok(null);
    if (url.match(/^\/api\/service-timeline\/[^/]+$/) && method === "DELETE") return ok({ deleted: true, records: ["attendance"] });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

const { render, cleanup } = await import("@testing-library/react");
const { fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");

/** The operator app wraps everything in a TooltipProvider (renderer/app/index.tsx)
 *  and mounts one ConfirmHost — every row here carries a tooltip and the delete
 *  button opens a confirm dialog; both throw/no-op without their provider. */
function mountSection(Section: React.ComponentType) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(Section),
      React.createElement(ConfirmHost),
    ),
  );
}

after(() => {
  cleanup();
  teardown();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Everything a rendered node says, whitespace flattened. */
const text = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

describe("History: a service still in its arrival ramp", () => {
  let ServiceHistorySection: typeof import("./service-history-section.js").ServiceHistorySection;

  before(async () => {
    ({ ServiceHistorySection } = await import("./service-history-section.js"));
  });

  beforeEach(() => {
    cleanup();
  });

  test("(a) shows one row, captioned 'arriving' with the last occupancy, and the day count is 1", async (t) => {
    installFetch({ list: [], attList: [arrivingAttendance()] });
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();

    const txt = text(view.container);
    assert.ok(txt.includes("Sunday Gathering"), `the attendance-only row never rendered: ${txt}`);
    assert.ok(txt.includes("arriving"), `the row isn't captioned "arriving": ${txt}`);
    assert.ok(txt.includes("42"), `the last occupancy (42) is missing from the caption: ${txt}`);

    // The calendar's day count for TODAY — HistoryCalendar renders each day
    // with data as a button labeled "N service(s)".
    const dayButtons = [...view.container.querySelectorAll("button[aria-label$='service']")];
    assert.equal(dayButtons.length, 1, `expected exactly one day marked with data: ${txt}`);
  });

  test("(b) opening the row shows the Attendance chart, and no items table or Copy report", async (t) => {
    installFetch({ list: [], attList: [arrivingAttendance()] });
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();

    const row = [...view.container.querySelectorAll("button")].find((b) => text(b as HTMLElement).includes("Sunday Gathering"));
    assert.ok(row, "the row's button never rendered");
    fireEvent.click(row!);
    await settle();
    await settle();

    const txt = text(view.container);
    assert.ok(txt.includes("Attendance"), `no Attendance heading: ${txt}`);
    assert.ok(view.container.querySelector("svg"), `no chart (svg) drawn: ${txt}`);
    assert.ok(!txt.includes("Copy report"), `the Copy report control assumes a timeline and should not be offered: ${txt}`);
    // The items-table header row ("Item" / "Plan" / "Actual" columns) never renders.
    assert.ok(!txt.includes("PlanActual"), `an items table rendered with no timeline to build one from: ${txt}`);
  });

  test("(d) the 'No service timings recorded yet' empty state is not shown", async (t) => {
    installFetch({ list: [], attList: [arrivingAttendance()] });
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();

    const txt = text(view.container);
    assert.ok(!txt.includes("No service timings recorded yet"), `the empty state showed with an attendance-only row present: ${txt}`);
  });

  /** Yesterday's finished service — a timeline record with nothing else, so the
   *  newest TIMELINE day is not today. */
  function yesterdayTimeline() {
    return {
      serviceKey: "weekend:plan-0:2026-09-02",
      serviceTypeId: "weekend",
      serviceTypeName: "Weekend",
      planId: "plan-0",
      planTitle: "Midweek",
      seriesTitle: null,
      serviceDate: "2026-09-02",
      serviceTimeId: "time-0",
      serviceTimeStartsAt: "2026-09-02T10:00:00Z",
      startedAt: "2026-09-02T10:01:00Z",
      endedAt: "2026-09-02T11:05:00Z",
      items: [],
    };
  }

  test("(e) the page lands on today when today is only an arrival ramp", async (t) => {
    // The timeline list and the attendance list are two fetches. Selecting the
    // newest day once, from whichever arrived first, left the page on yesterday
    // while today's ramp sat one calendar click away — the operator opened
    // History to watch the room fill and saw last night's service instead.
    //
    // Order matters and is modelled: the page mounts with yesterday only and
    // picks it, THEN today's ramp begins over SSE. With both lists in the first
    // fetch, today is the newest day from the start and the old select-once rule
    // passes too — that version of this test was vacuous and was rewritten.
    installFetch({ list: [yesterdayTimeline()], attList: [] });
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    assert.ok(text(view.container).includes("Midweek"), "precondition: yesterday selected first");

    FakeEventSource.last?.push("attendance:history", arrivingAttendance());
    await settle();
    await settle();

    const txt = text(view.container);
    assert.ok(txt.includes("Sunday Gathering"), `today's arriving row is not on the selected day: ${txt}`);
    assert.ok(!txt.includes("Midweek"), `the page stayed on yesterday's service: ${txt}`);
  });

  test("(f) but a day the operator picked is not taken away from them", async (t) => {
    installFetch({ list: [yesterdayTimeline()], attList: [] });
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    assert.ok(text(view.container).includes("Midweek"), "precondition: yesterday selected");

    // Operator clicks yesterday explicitly (the one day with data), then today's
    // ramp begins.
    const dayButton = view.container.querySelector("button[aria-label$='service']") as HTMLElement;
    assert.ok(dayButton, "no calendar day button to pick");
    fireEvent.click(dayButton);
    FakeEventSource.last?.push("attendance:history", arrivingAttendance());
    await settle();
    await settle();

    const txt = text(view.container);
    assert.ok(txt.includes("Midweek"), `a day the operator picked was switched away from: ${txt}`);
    assert.ok(!txt.includes("Sunday Gathering"), `today's row appeared on a day the operator had picked: ${txt}`);
  });

  test("(c) a service-timeline:history push for the same key collapses to one normal row", async (t) => {
    installFetch({ list: [], attList: [arrivingAttendance()] });
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();

    assert.ok(text(view.container).includes("arriving"), "precondition: row should start out captioned 'arriving'");

    const timeline = {
      serviceKey: SERVICE_KEY,
      serviceTypeId: "weekend",
      serviceTypeName: "Weekend",
      planId: "plan-1",
      planTitle: "Sunday Gathering",
      seriesTitle: null,
      serviceDate: TODAY,
      serviceTimeId: "time-1",
      serviceTimeStartsAt: `${TODAY}T10:00:00Z`,
      startedAt: `${TODAY}T10:00:05Z`,
      endedAt: null,
      items: [
        {
          itemId: "item-1",
          title: "Welcome",
          sequence: 0,
          plannedLengthSec: 120,
          startedAt: `${TODAY}T10:00:05Z`,
          endedAt: null,
          actualDurationSec: null,
        },
      ],
    };
    FakeEventSource.last!.push("service-timeline:history", timeline);
    await settle();
    await settle();

    const txt = text(view.container);
    const rows = [...view.container.querySelectorAll("button")].filter((b) => text(b as HTMLElement).includes("Sunday Gathering"));
    assert.equal(rows.length, 1, `expected exactly one row for the service, got ${rows.length}: ${txt}`);
    assert.ok(!txt.includes("arriving"), `the row still reads "arriving" after the timeline record arrived: ${txt}`);
  });
});

// ── Guard proof ──────────────────────────────────────────────────────────────
//
// Required by CLAUDE.md: a test written to catch a class of bug ships with
// proof it actually catches it. Deleting the union (rows built from `list`
// alone, the pre-fix behavior) must fail (a), (b) and (d) above — recorded
// here instead of by hand-editing the source back and forth, so the proof
// travels with the suite.
//
// Ran once, by hand, against a version of `rows` reverted to
// `(list ?? []).map(...)` — no attOnlyRows branch — in service-history-section.tsx.
// All four went red (node --import tsx --test), exact assertion messages:
//
//   (a) AssertionError: the attendance-only row never rendered:
//   (b) AssertionError: the row's button never rendered
//   (d) AssertionError: the empty state showed with an attendance-only row
//       present: No service timings recorded yetItem timings are captured
//       automatically while a service runs in Planning Center Live — when
//       each item goes live and how long it runs versus its planned length.
//   (c) AssertionError: precondition: row should start out captioned
//       'arriving' — expected, since with no union there is no attendance-only
//       row to ever be captioned that way; (c) makes no claim the guard tests.
//
// `tests 4 / pass 0 / fail 4`. Restoring the attOnlyRows branch put all four
// back to green (`tests 4 / pass 4 / fail 0`).
