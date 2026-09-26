// All services: each row's sound record is read once, and a live push is never
// overwritten by the older answer of a read it raced.
//
// The month's key list grows as the page's reads land: the timeline list's
// rows first, then the attendance list adds a service with no timeline of its
// own. The per-row fetch used to ask for the whole month each time the list
// changed, so every service on it was read twice on every visit — 41 requests
// for a 21-service month. It now asks only for keys it has not asked for, and
// asks again for one whose read failed.
//
// A service that has just started recording is the other case. Its key enters
// the month, its read goes out, and the recorder's push can arrive over the
// open stream before that read answers. The answer is the older record, and
// writing it over the push put the row back to "no sound recorded" until the
// next push.
//
// Driven through the real section with a stubbed fetch that can hold a read
// back, so the reads land in separate renders as they do over a real network,
// and a stream a test can push on.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stream a test can push on, as the server's SSE does. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onopen: unknown = null;
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
    for (const fn of this.listeners.get(channel) ?? []) fn({ data: JSON.stringify(payload) } as MessageEvent);
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const DAY = "2026-09-13";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

const base = (key: string, start: string) => ({
  serviceKey: key,
  serviceTypeId: "weekend",
  serviceTypeName: "Weekend",
  planId: "plan-1",
  planTitle: "Sunday",
  seriesTitle: null,
  serviceDate: DAY,
  serviceTimeId: key,
  serviceTimeStartsAt: iso(start),
  startedAt: iso(start),
});

const timeline = (key: string, start: string, end: string) =>
  ({ ...base(key, start), endedAt: iso(end), items: [] }) as unknown as ServiceTimeline;

const attendance = (key: string, start: string, end: string) =>
  ({
    ...base(key, start),
    serviceStartedAt: iso(start),
    endedAt: iso(end),
    attendanceBaseline: 0,
    totalAttendance: 300,
    peakAttendance: 300,
    peakOccupancy: 250,
    minOccupancy: 10,
    lastAttendance: 300,
    lastOccupancy: 250,
  }) as unknown as ServiceAttendanceSummary;

/** A sound record with a level, as the recorder pushes it. */
const soundRecord = (key: string, start: string) =>
  ({
    ...base(key, start),
    meterId: "meter-1",
    metricKey: "LAeq 10",
    endedAt: null,
    items: [
      {
        itemId: "a",
        title: "Worship",
        sequence: 0,
        metrics: { "LAeq 10": { max: 101.8, avg: 94, leq: 95.6, count: 900 } },
        maxSpl: 101.8,
        sampleCount: 900,
        startedAt: iso(start),
        endedAt: null,
      },
    ],
  }) as unknown as ServiceSplHistory;

const NINE = "weekend:plan-1:0900";
const ELEVEN = "weekend:plan-1:1100";
/** Counted, with no timeline: its row arrives with the attendance list. */
const FIVE = "weekend:plan-1:1700";

/** What the stubbed server answers, and which reads it is holding back. */
const server = {
  timeline: [] as ServiceTimeline[],
  attendance: [] as ServiceAttendanceSummary[],
  /** How many times each service's sound record was asked for. */
  splReads: new Map<string, number>(),
  /** A key whose first sound read fails, as a server restarting would. */
  splFailsOnce: null as string | null,
  holdAttendance: null as Promise<void> | null,
  holdSpl: null as Promise<void> | null,
};
const gate = () => {
  let open = () => {};
  const held = new Promise<void>((r) => (open = r));
  return { held, open };
};

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (url === "/api/service-timeline") return ok(server.timeline);
  if (url === "/api/attendance/history?summary=1") {
    if (server.holdAttendance) await server.holdAttendance;
    return ok(server.attendance);
  }
  if (url === "/api/spl/summary") return ok([]);
  if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
  if (url === "/api/baptism/sessions") return ok([]);
  const spl = /^\/api\/spl\/history\/([^/?]+)$/.exec(url);
  if (spl) {
    const key = decodeURIComponent(spl[1]);
    const n = (server.splReads.get(key) ?? 0) + 1;
    server.splReads.set(key, n);
    if (server.holdSpl) await server.holdSpl;
    if (key === server.splFailsOnce && n === 1) throw new TypeError("fetch failed");
    return ok(null);
  }
  return ok(null);
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

afterEach(() => {
  cleanup();
  // spl:history is replayed to a late subscriber; a pushed record must not
  // reach the next case.
  __resetReplayCacheForTests();
  Object.assign(server, { splReads: new Map(), splFailsOnce: null, holdAttendance: null, holdSpl: null });
});
after(() => {
  cleanup();
  teardown();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function renderHistory(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    const section = React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly: true });
    view = render(React.createElement(TooltipProvider, null, section));
  });
  await settle();
  return view;
}

const rowText = (view: ReturnType<typeof render>, key: string) =>
  view.container.querySelector(`[data-history-row="${key}"]`)?.textContent ?? "";

describe("the All services rows' sound records", () => {
  test("are each read once as the list's reads land, and a failed one is read again", async () => {
    server.timeline = [timeline(NINE, "09:00:00", "10:20:00"), timeline(ELEVEN, "11:00:00", "12:20:00")];
    server.attendance = [
      attendance(NINE, "09:00:00", "10:20:00"),
      attendance(ELEVEN, "11:00:00", "12:20:00"),
      attendance(FIVE, "17:00:00", "18:20:00"),
    ];
    server.splFailsOnce = ELEVEN;
    const attendanceGate = gate();
    server.holdAttendance = attendanceGate.held;

    await renderHistory();
    assert.deepEqual(Object.fromEntries(server.splReads), { [NINE]: 1, [ELEVEN]: 1 }, "sanity: the timeline list's rows were read first");

    attendanceGate.open();
    await settle();
    assert.deepEqual(
      Object.fromEntries(server.splReads),
      { [NINE]: 1, [ELEVEN]: 2, [FIVE]: 1 },
      "the 9 read once, the 11 again after its read failed, the 5 once it had a row",
    );
  });

  test("keep a live push that arrived while the row's own read was out", async () => {
    server.timeline = [timeline(NINE, "09:00:00", "10:20:00")];
    server.attendance = [attendance(NINE, "09:00:00", "10:20:00")];
    const splGate = gate();
    server.holdSpl = splGate.held;

    const view = await renderHistory();
    assert.equal(server.splReads.get(NINE), 1, "sanity: the row's read is out");

    await act(async () => FakeEventSource.last!.push("spl:history", soundRecord(NINE, "09:00:00")));
    assert.match(rowText(view, NINE), /dB/, "sanity: the push gave the row its level");

    // The read answers with what the server had when it was asked: nothing yet.
    splGate.open();
    await settle();
    assert.match(rowText(view, NINE), /dB/, "the read's older answer replaced the pushed record");
    assert.doesNotMatch(rowText(view, NINE), /no sound recorded/);
  });
});
