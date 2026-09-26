// Going back to History draws what it last showed, at once.
//
// History waited on its three list reads on every visit, so every return to
// the page opened on a skeleton while it downloaded the same lists again. The
// app now keeps what the page showed (see history-shown.tsx), and a later visit
// draws from that while its own reads run, then takes their answers.
//
// Three things are asserted, each the way the cache could quietly be wrong:
//
//   a return visit    draws the kept lists before its reads land, then the reads'
//   a live push       is kept, so the next visit does not draw the list it replaced
//   a failed read     is forgotten, so the next visit waits instead of drawing an
//                     empty history as if it were one
//
// Driven through the real section inside the real provider, with a stubbed
// fetch that can hold the list reads back, and a stream a test can push on.
// The stream's replay cache is cleared between visits: it replays the last
// pushed record to the next visit's subscriber, and would otherwise supply the
// pushed service itself, green whether the cache kept it or not.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

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
const NINE = { key: "weekend:plan-1:0900", start: "09:00:00", end: "10:20:00" };
const ELEVEN = { key: "weekend:plan-1:1100", start: "11:00:00", end: "12:20:00" };
const FIVE = { key: "weekend:plan-1:1700", start: "17:00:00", end: "18:20:00" };
type Service = typeof NINE;

const base = (s: Service) => ({
  serviceKey: s.key,
  serviceTypeId: "weekend",
  serviceTypeName: "Weekend",
  planId: "plan-1",
  planTitle: "Sunday",
  seriesTitle: null,
  serviceDate: DAY,
  serviceTimeId: s.key,
  serviceTimeStartsAt: iso(s.start),
  startedAt: iso(s.start),
  endedAt: iso(s.end),
});
const timeline = (s: Service) => ({ ...base(s), items: [] }) as unknown as ServiceTimeline;
const attendance = (s: Service) =>
  ({
    ...base(s),
    serviceStartedAt: iso(s.start),
    attendanceBaseline: 0,
    totalAttendance: 300,
    peakAttendance: 300,
    peakOccupancy: 250,
    minOccupancy: 10,
    lastAttendance: 300,
    lastOccupancy: 250,
  }) as unknown as ServiceAttendanceSummary;

type ListRead = "timeline" | "attendance";
/** What the stubbed server answers, and whether it is holding the list reads. */
const server = {
  services: [] as Service[],
  failing: new Set<ListRead>(),
  held: null as Promise<void> | null,
  release: () => {},
};
function holdListReads(): void {
  server.held = new Promise<void>((r) => (server.release = r));
}

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  const list: ListRead | null =
    url === "/api/service-timeline" ? "timeline" : url === "/api/attendance/history?summary=1" ? "attendance" : null;
  if (list) {
    if (server.held) await server.held;
    if (server.failing.has(list)) throw new TypeError("fetch failed");
    return ok(list === "timeline" ? server.services.map(timeline) : server.services.map(attendance));
  }
  if (url === "/api/spl/summary") return ok([]);
  if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
  if (url === "/api/baptism/sessions") return ok([]);
  return ok(null);
};

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { HistoryShownProvider } = await import("./history-shown.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  server.release();
  server.held = null;
  server.failing.clear();
  cleanup();
  __resetReplayCacheForTests();
});

/** The app around History: the provider stays mounted while the page comes and goes. */
const app = (historyOpen: boolean) =>
  React.createElement(
    HistoryShownProvider,
    null,
    React.createElement(TooltipProvider, null, historyOpen ? React.createElement(ServiceHistorySection) : null),
  );

async function settleReads(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle();
}

/** Open History for the first time, with the reads answering. */
async function firstVisit(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(app(true));
  });
  await settleReads();
  return view;
}

/** Leave History, then come back to it with the list reads held. */
async function returnWithReadsHeld(view: ReturnType<typeof render>): Promise<void> {
  view.rerender(app(false));
  await settle();
  __resetReplayCacheForTests();
  holdListReads();
  view.rerender(app(true));
  await settle();
}

const rowKeys = (view: ReturnType<typeof render>) =>
  [...view.container.querySelectorAll("[data-history-row]")].map((r) => r.getAttribute("data-history-row"));
const pageText = (view: ReturnType<typeof render>) => view.container.textContent ?? "";

describe("going back to History", () => {
  test("draws the lists it showed before its own reads land, then takes theirs", async () => {
    server.services = [NINE, ELEVEN];
    const view = await firstVisit();
    assert.deepEqual(rowKeys(view), [ELEVEN.key, NINE.key], "sanity: the first visit drew both services");

    server.services = [NINE, ELEVEN, FIVE];
    await returnWithReadsHeld(view);
    assert.deepEqual(rowKeys(view), [ELEVEN.key, NINE.key], "the return visit waited on its reads instead of drawing what it had");
    assert.ok(view.container.querySelector('[aria-label="Trend range"]'), "sanity: the Trends card is on the page");
    assert.equal(view.container.querySelector("[data-trends-loading]"), null, "Trends said it was loading with the lists in hand");

    server.release();
    await settleReads();
    assert.deepEqual(rowKeys(view), [FIVE.key, ELEVEN.key, NINE.key], "the return visit's own reads did not replace what it drew");
  });

  test("draws a service a live push added while it was open", async () => {
    server.services = [NINE];
    const view = await firstVisit();
    await act(async () => FakeEventSource.last!.push("service-timeline:history", timeline(ELEVEN)));
    assert.deepEqual(rowKeys(view), [ELEVEN.key, NINE.key], "sanity: the push added its row");

    await returnWithReadsHeld(view);
    assert.deepEqual(rowKeys(view), [ELEVEN.key, NINE.key], "the return visit drew the list the push had replaced");
  });

  test("after a failed read, waits for its reads instead of drawing an empty history", async () => {
    server.services = [NINE];
    const view = await firstVisit();

    view.rerender(app(false));
    await settle();
    server.failing = new Set(["timeline", "attendance"]);
    view.rerender(app(true));
    await settleReads();
    assert.match(pageText(view), /could not be read/, "sanity: the second visit's failed reads said so");

    server.failing.clear();
    await returnWithReadsHeld(view);
    assert.deepEqual(rowKeys(view), [], "a row was drawn from lists no read had confirmed");
    assert.doesNotMatch(pageText(view), /No service timings recorded yet/, "an unread history said nothing had been recorded");
    assert.ok(view.container.querySelector(".animate-pulse"), "the page did not show it was loading");
  });
});
