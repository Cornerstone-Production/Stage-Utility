// All services: each row's sound record is read once, not once per list read.
//
// The month's key list grows as the page's reads land: the timeline list's
// rows first, then the attendance list adds a service with no timeline of its
// own. The per-row fetch used to ask for the whole month each time the list
// changed, so every service on it was read twice on every visit — 41 requests
// for a 21-service month. It now asks only for keys it has not asked for, and
// asks again for one whose read failed.
//
// Driven through the real section with a stubbed fetch that holds the
// attendance list back, so the two list reads land in two renders, as they do
// over a real network.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
};

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

const NINE = "weekend:plan-1:0900";
const ELEVEN = "weekend:plan-1:1100";
/** Counted, with no timeline: its row arrives with the attendance list. */
const FIVE = "weekend:plan-1:1700";

/** How many times each service's sound record was asked for. */
const splReads = new Map<string, number>();
let releaseAttendance: () => void = () => {};

function installFetch(): void {
  const held = new Promise<void>((r) => (releaseAttendance = r));
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url === "/api/service-timeline") return ok([timeline(NINE, "09:00:00", "10:20:00"), timeline(ELEVEN, "11:00:00", "12:20:00")]);
    if (url === "/api/attendance/history?summary=1") {
      await held;
      return ok([attendance(NINE, "09:00:00", "10:20:00"), attendance(ELEVEN, "11:00:00", "12:20:00"), attendance(FIVE, "17:00:00", "18:20:00")]);
    }
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/baptism/sessions") return ok([]);
    const spl = /^\/api\/spl\/history\/([^/?]+)$/.exec(url);
    if (spl) {
      const key = decodeURIComponent(spl[1]);
      const n = (splReads.get(key) ?? 0) + 1;
      splReads.set(key, n);
      // The 11 o'clock's first read fails, as a server restarting would.
      if (key === ELEVEN && n === 1) throw new TypeError("fetch failed");
      return ok(null);
    }
    return ok(null);
  };
}

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHistorySection } = await import("./service-history-section.js");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

describe("the All services rows' sound records", () => {
  test("are each read once as the list's reads land, and a failed one is read again", async () => {
    installFetch();
    await act(async () => {
      const section = React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly: true });
      render(React.createElement(TooltipProvider, null, section));
    });
    await settle();
    assert.deepEqual(Object.fromEntries(splReads), { [NINE]: 1, [ELEVEN]: 1 }, "sanity: the timeline list's rows were read first");

    releaseAttendance();
    await settle();
    assert.deepEqual(
      Object.fromEntries(splReads),
      { [NINE]: 1, [ELEVEN]: 2, [FIVE]: 1 },
      "the 9 read once, the 11 again after its read failed, the 5 once it had a row",
    );
  });
});
