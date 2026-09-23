// header-live-e2e.test.tsx — the Baptisms header's live check, driven against
// the REAL server-side pieces rather than a stub: the real `historyRoutes`
// dispatcher, the real broadcaster delivering to the header's own SSE client,
// and the three real recorders (`serviceTimelineRecorder`, `attendanceRecorder`,
// `splRecorder`) ticked in the live-poller's own order.
//
// header.test.tsx already proves the DECISION logic (which of "checking",
// "live", "not-live" or "failed" a given server answer produces, and what each
// one disables) against a stubbed fetch — that is the right tool for
// exhaustively covering every branch fast. This file proves the WIRING: that
// closing a service on the real recorders, through the real route, actually
// reaches this header and flips its button — the one thing a stubbed-fetch
// test cannot show, because the stub IS the thing being proven correct here.

import { strict as assert } from "node:assert";
import { after, afterEach, mock, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-header-e2e-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";
const teardown = installRenderDom();

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

const { setAppTimeZone } = await import("../../../../main/services/app-timezone.js");
setAppTimeZone("America/Chicago");
const { stageController } = await import("../../../../main/services/stage-controller.js");
const { serviceTimelineRecorder } = await import("../../../../main/services/service-timeline-recorder.js");
const { attendanceRecorder } = await import("../../../../main/services/attendance-recorder.js");
const { splRecorder } = await import("../../../../main/services/spl-recorder.js");
const { historyRoutes } = await import("../../../../main/services/routes/history-routes.js");
const { callRoute } = await import("../../../../main/services/routes/route-harness.js");
const { addBroadcastListener } = await import("../../../../main/services/broadcaster.js");
const { SERVICE_GAP_MS } = await import("../../../../main/services/service-recorder.js");

const { render, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { TooltipProvider, ConfirmHost } = await import("../../../components/ui/index.js");
const { BaptismHeader } = await import("./header.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

addBroadcastListener((channel, payload) => FakeEventSource.last?.push(channel, payload));

const IDLE = {
  mode: "grouped", phase: "idle", personNumber: 0, baptismIndex: 0, armed: false,
  segmentStartedAt: null, segmentAccumMs: 0, sessionStartedAt: null, finishedAt: null,
  people: [], pendingTestimonyMs: null, serviceTitle: null, serviceTypeId: null, planId: null, serviceKey: null,
} as unknown as BaptismState;

let planN = 0;
let planId = "";
function freshPlan(): void {
  planId = `plan-e2e-${++planN}`;
  (stageController as unknown as { getState(): unknown }).getState = () => ({
    serviceTypeId: "75953", serviceTypeName: "Weekend", planId, planTitle: "E2E", planSeriesTitle: null,
  });
}

const OCC = "900001";
function liveItem(itemId: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    mode: "item", currentItemId: itemId, label: itemId, itemType: null, lengthSec: 300, liveStartAt: now,
    targetAt: null, serverNow: now, currentItemTitle: itemId, nextItemTitle: null,
    serviceTimeId: OCC, serviceTimeStartsAt: new Date(Date.now() - 5 * 60_000).toISOString(), beforeServiceStart: false,
    ...extra,
  } as never;
}
function liveNone() {
  const now = new Date().toISOString();
  return {
    mode: "none", currentItemId: null, label: null, itemType: null, lengthSec: null, liveStartAt: null,
    targetAt: null, serverNow: now, currentItemTitle: null, nextItemTitle: null,
    serviceTimeId: OCC, serviceTimeStartsAt: new Date(Date.now() - 60 * 60_000).toISOString(), beforeServiceStart: false,
  } as never;
}
/** One live-poller tick: the three recorders fired in its own order, not
 *  awaited between one another — matching main/services/live-poller.ts. */
async function pollerTick(live: never): Promise<void> {
  await Promise.all([splRecorder.onLiveTick(live), attendanceRecorder.onLiveTick(live), serviceTimelineRecorder.onLiveTick(live)]);
}

const keyNow = () => `75953:${planId}:${OCC}`;
function forgetAll(key: string): void {
  for (const r of [splRecorder, attendanceRecorder, serviceTimelineRecorder]) r.forget(key);
}

/** setImmediate stays real even while setTimeout/setInterval are faked — see
 *  session-chart-refetch.test.tsx, which established this idiom. `settle()`'s
 *  own `setTimeout(resolve, 0)` would otherwise never fire once fake timers
 *  are enabled — so any test that enables `mock.timers` before mounting must
 *  wait with THIS, not `settle()`, including inside `mountHeader` below. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
}

async function mountHeader(serviceKey: string, wait: () => Promise<void> = settle) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/service-timeline/current") || url.includes("/api/history/live")) {
      const out = await callRoute(historyRoutes, url);
      return { ok: (out.status ?? 500) < 400, status: out.status, json: async () => out.json, text: async () => out.body };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }) as unknown as typeof fetch;
  const state = { ...IDLE, serviceKey, finishedAt: new Date().toISOString() } as BaptismState;
  const view = render(React.createElement(TooltipProvider, null,
    React.createElement(BaptismHeader, { state, sessions: [], onRebuilt: () => {} }),
    React.createElement(ConfirmHost)));
  await wait();
  await wait();
  return { view, restore: () => { globalThis.fetch = realFetch; } };
}
const btn = (root: ParentNode) => [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Rebuild from raw")) as HTMLButtonElement;

test("live on the real recorders disables the button; PCO reporting mode 'none' enables it", async () => {
  freshPlan();
  await pollerTick(liveItem("song-1"));
  const key = keyNow();
  const { view, restore } = await mountHeader(key);
  try {
    const disabledWhileLive = btn(view.container).disabled;
    await act(async () => {
      await pollerTick(liveNone());
    });
    await settle();
    await settle();
    await settle();
    assert.equal(disabledWhileLive, true, "the real recorders were live, but the button was not disabled");
    assert.equal(btn(view.container).disabled, false, "the service ended on the real recorders, but the button stayed disabled");
  } finally {
    restore();
    forgetAll(key);
  }
});

test("no live-poller tick for a while (a dropped PCO poll, or the plan deselected) is still caught — by the backstop, not a push", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    freshPlan();
    await pollerTick(liveItem("song-1"));
    const key = keyNow();
    const { view, restore } = await mountHeader(key, flush);
    try {
      assert.equal(btn(view.container).disabled, true, "precondition: the real recorders are live on this key");

      // No further ticks at all — a dropped PCO poll, or the plan being
      // deselected — so `isRecording` will read false once SERVICE_GAP_MS
      // has passed, but nothing ever BROADCASTS that: there is no push for
      // this header to react to. Poked directly rather than waiting
      // SERVICE_GAP_MS (10 minutes) of real or even fake time, matching how
      // the live-poller itself decides staleness.
      for (const r of [splRecorder, attendanceRecorder, serviceTimelineRecorder]) {
        (r as unknown as { lastLiveAt: number }).lastLiveAt = Date.now() - SERVICE_GAP_MS - 1;
      }

      await act(async () => {
        mock.timers.tick(30_000);
      });
      await flush();
      assert.equal(
        btn(view.container).disabled,
        false,
        "the service went silent with no push to announce it, and the 30-second backstop did not catch it",
      );
    } finally {
      restore();
      forgetAll(key);
    }
  } finally {
    mock.timers.reset();
  }
});
