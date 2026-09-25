// The All-services list must take live pushes for a row it already drew, not
// only for the open detail.
//
// The incident (24 Sep 2026, v1.23.0): a service split mid-page-load. The
// second service's row appeared (its timeline record pushed fine) but its
// sound column read "no sound recorded" the whole time it was recording —
// nine items in, ~97 dB — because the list's per-month SPL fetch had already
// run and nothing after that kept splByKey current. A reload fixed it. The
// `spl:history` push handler updated the open detail (setSpl) and nothing
// else.
//
// Driven through the real ServiceHistorySection and renderer/lib/api.ts, with
// a fake EventSource pushed on directly — the same approach
// history-service-page.test.tsx uses for its own live-channel cases, and the
// same fixture shape history-list-rows.test.tsx uses for the list itself.
//
// NOT ASSERTED HERE: layout, colour, the stylesheet. jsdom loads none of that.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, settle } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Same shape as history-service-page.test.tsx's — a fake EventSource that can
 *  be pushed on directly, so a live channel update can be modelled without a
 *  real server. */
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
    for (const fn of this.listeners.get(channel) ?? []) fn({ data: JSON.stringify(payload) } as MessageEvent);
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};

const DAY = "2026-09-24";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();
const KEY = "salt:plan-1:2015";

/** The second service's own record — still recording (`endedAt: null`), the
 *  state the row is in the whole time this test drives it. */
function timeline(): ServiceTimeline {
  return {
    serviceKey: KEY,
    serviceTypeId: "salt",
    serviceTypeName: "The Salt Company",
    planId: "plan-1",
    planTitle: "8:15pm",
    seriesTitle: "Kickoff",
    serviceDate: DAY,
    serviceTimeId: "2015",
    serviceTimeStartsAt: iso("20:15:00"),
    startedAt: iso("20:15:00"),
    endedAt: null,
    items: [
      { itemId: "a", title: "Doors", sequence: 0, plannedLengthSec: 300, startedAt: iso("20:15:00"), endedAt: iso("20:20:00"), actualDurationSec: 300, counted: true },
    ],
  } as unknown as ServiceTimeline;
}

function attendance(): ServiceAttendance {
  return {
    serviceKey: KEY,
    serviceTypeId: "salt",
    serviceTypeName: "The Salt Company",
    planId: "plan-1",
    planTitle: "8:15pm",
    seriesTitle: "Kickoff",
    serviceDate: DAY,
    serviceTimeId: "2015",
    serviceTimeStartsAt: iso("20:15:00"),
    startedAt: iso("20:15:00"),
    endedAt: null,
    samples: [],
    attendanceBaseline: 0,
    totalAttendance: 400,
    peakAttendance: 400,
    peakOccupancy: 350,
    minOccupancy: 10,
    lastAttendance: 400,
    lastOccupancy: 350,
  } as unknown as ServiceAttendance;
}

/** The SPL record as it exists once the meter has been running a while — nine
 *  items, a real peak. Not present on disk when the page's per-month fetch
 *  ran; it only ever arrives as a live push. */
function splRecording(): ServiceSplHistory {
  return {
    serviceKey: KEY,
    serviceTypeId: "salt",
    planId: "plan-1",
    planTitle: "8:15pm",
    seriesTitle: "Kickoff",
    serviceDate: DAY,
    serviceTimeId: "2015",
    serviceTimeStartsAt: iso("20:15:00"),
    meterId: "meter-1",
    metricKey: "SPL A Slow",
    startedAt: iso("20:15:00"),
    endedAt: null,
    items: [
      {
        itemId: "a",
        title: "Doors",
        sequence: 0,
        metrics: { "SPL A Slow": { max: 97.3, avg: 90, leq: 91, count: 200 } },
        maxSpl: 97.3,
        sampleCount: 200,
        startedAt: iso("20:15:00"),
        endedAt: iso("20:20:00"),
      },
    ],
  } as unknown as ServiceSplHistory;
}

/** The fetch stub. The month's per-key SPL read answers null — nothing has
 *  been persisted for this key by the time the row's own effect asked, which
 *  is exactly the race the incident hit. */
function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url === "/api/service-timeline") return ok([timeline()]);
    if (url === "/api/attendance/history") return ok([attendance()]);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/baptism/sessions") return ok([]);
    if (url.startsWith("/api/baptism/lane")) return ok({ spans: [] });
    if (url === `/api/service-timeline/${encodeURIComponent(KEY)}`) return ok(timeline());
    if (url === `/api/spl/history/${encodeURIComponent(KEY)}`) return ok(null);
    return ok(null);
  };
}

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { ServiceHistorySection } = await import("./service-history-section.js");
const { serviceKpis } = await import("./history-service-header.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

afterEach(() => {
  cleanup();
  // Every one of the three channels this file pushes on is hydrated (see
  // sse-channels.ts) — a subscriber that mounts after a push replays the LAST
  // one on connect. Without this, a payload pushed in one case is replayed
  // into the next case's freshly-mounted page.
  __resetReplayCacheForTests();
});
after(teardown);

async function renderList(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly: false }),
      ),
    );
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

function figuresOf(row: Element): Record<string, { value: string; caption: string }> {
  const out: Record<string, { value: string; caption: string }> = {};
  for (const f of row.querySelectorAll("[data-row-figure]")) {
    const key = f.getAttribute("data-row-figure") ?? "";
    const [value, caption] = [...f.children].map((c) => (c.textContent ?? "").trim());
    out[key] = { value, caption };
  }
  return out;
}

describe("a live push updates a row already on screen", () => {
  test("spl:history for a record the month fetch missed fills in the row's peak, without a reload", async () => {
    installFetch();
    const view = await renderList();
    const row = view.container.querySelector(`[data-history-row="${KEY}"]`)!;
    assert.ok(row, "the row never rendered");

    // Before the push: the month fetch answered null, so the row has nothing.
    assert.equal(figuresOf(row).level.caption, "no sound recorded", "expected the row to start with no sound recorded");

    FakeEventSource.last!.push("spl:history", splRecording());
    await settle();

    const drawn = figuresOf(view.container.querySelector(`[data-history-row="${KEY}"]`)!);
    const kpis = new Map(serviceKpis(timeline(), attendance(), splRecording()).map((k) => [k.key, k]));
    assert.equal(
      drawn.level.value,
      kpis.get("level")!.value,
      `the row did not pick up the pushed SPL record: ${JSON.stringify(drawn)}`,
    );
    assert.notEqual(drawn.level.caption, "no sound recorded", "the row is still reading as silent");
  });

  test("service-timeline:history with endedAt set drops the recording pill from an already-listed row", async () => {
    installFetch();
    const view = await renderList();
    const row = view.container.querySelector(`[data-history-row="${KEY}"]`) as HTMLElement;
    assert.equal(
      row.querySelectorAll('[data-testid="recording-pill"]').length,
      1,
      "expected the still-open row to carry the recording pill",
    );

    const closed: ServiceTimeline = { ...timeline(), endedAt: iso("21:45:00") };
    closed.items = closed.items.map((it) => ({ ...it, endedAt: it.endedAt ?? iso("21:45:00") }));
    FakeEventSource.last!.push("service-timeline:history", closed);
    await settle();

    const after = view.container.querySelector(`[data-history-row="${KEY}"]`) as HTMLElement;
    assert.equal(
      after.querySelectorAll('[data-testid="recording-pill"]').length,
      0,
      "the row is still showing the recording pill after the record closed",
    );
  });
});
