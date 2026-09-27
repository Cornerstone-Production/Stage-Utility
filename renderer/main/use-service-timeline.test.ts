// use-service-timeline.test.ts — a push naming a DIFFERENT, already-ENDED,
// earlier service while this hook holds an OPEN one must not replace it.
// "service-timeline:history" broadcasts every post-hoc History edit of a
// closed record too, and this hook used to accept every
// push unconditionally — an item-time correction on last week's service
// blanked the live plan lane and the "Service pacing" layout object until the
// real live service's next item change.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { renderHook, cleanup, act } = await import("@testing-library/react");
const { useServiceTimeline } = await import("./use-service-timeline.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

function okResponse(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => "" };
}

const LIVE: ServiceTimeline = {
  serviceKey: "svc-live",
  serviceTypeId: "st1",
  planId: "plan-1",
  planTitle: "Evening",
  seriesTitle: null,
  serviceDate: "2026-09-27",
  serviceTimeId: null,
  serviceTimeStartsAt: null,
  startedAt: "2026-09-27T15:00:00.000Z",
  endedAt: null,
  items: [
    { itemId: "song", title: "Song", sequence: 0, plannedLengthSec: 300, startedAt: "2026-09-27T15:00:00.000Z", endedAt: null, actualDurationSec: null },
  ],
};

const EDITED_PAST_SERVICE: ServiceTimeline = {
  ...LIVE,
  serviceKey: "svc-last-week",
  startedAt: "2026-09-20T15:00:00.000Z",
  endedAt: "2026-09-20T16:00:00.000Z",
  items: [
    { itemId: "song", title: "Song", sequence: 0, plannedLengthSec: 300, startedAt: "2026-09-20T15:04:00.000Z", endedAt: "2026-09-20T15:09:00.000Z", actualDurationSec: 300 },
  ],
};

test("a History edit of a different, already-ended service does not replace the live one", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/service-timeline/current")) return okResponse(LIVE);
    return okResponse({});
  }) as unknown as typeof fetch;
  try {
    const { result } = renderHook(() => useServiceTimeline());
    await act(async () => {
      await settle();
      await settle();
    });
    assert.equal(result.current?.serviceKey, "svc-live", "sanity: the live record hydrated");

    // Someone corrects an item time on LAST week's service, in History.
    await act(async () => {
      FakeEventSource.last!.push("service-timeline:history", EDITED_PAST_SERVICE);
      await settle();
      await settle();
    });

    assert.equal(
      result.current?.serviceKey,
      "svc-live",
      `a push for a different, ended service replaced the live one (now ${result.current?.serviceKey}) — the plan lane and Service pacing would go blank`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the SAME service's own push (an item change, or it ending for real) still updates", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/service-timeline/current")) return okResponse(LIVE);
    return okResponse({});
  }) as unknown as typeof fetch;
  try {
    const { result } = renderHook(() => useServiceTimeline());
    await act(async () => {
      await settle();
      await settle();
    });
    assert.equal(result.current?.items[0]?.title, "Song");

    const nextItem: ServiceTimeline = {
      ...LIVE,
      items: [
        { ...LIVE.items[0]!, endedAt: "2026-09-27T15:05:00.000Z", actualDurationSec: 300 },
        { itemId: "sermon", title: "Sermon", sequence: 1, plannedLengthSec: 1800, startedAt: "2026-09-27T15:05:00.000Z", endedAt: null, actualDurationSec: null },
      ],
    };
    await act(async () => {
      FakeEventSource.last!.push("service-timeline:history", nextItem);
      await settle();
      await settle();
    });
    assert.equal(result.current?.items.length, 2, "the same service's own item change must still reach this hook");

    await act(async () => {
      FakeEventSource.last!.push("service-timeline:history", { ...nextItem, endedAt: "2026-09-27T16:00:00.000Z" });
      await settle();
      await settle();
    });
    assert.equal(result.current?.endedAt, "2026-09-27T16:00:00.000Z", "the live service ending for real must still reach this hook");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("once this hook's own service has ended, a later push (any other service) is accepted normally", async () => {
  const ENDED: ServiceTimeline = { ...LIVE, endedAt: "2026-09-27T16:00:00.000Z" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/service-timeline/current")) return okResponse(ENDED);
    return okResponse({});
  }) as unknown as typeof fetch;
  try {
    const { result } = renderHook(() => useServiceTimeline());
    await act(async () => {
      await settle();
      await settle();
    });
    assert.equal(result.current?.endedAt, "2026-09-27T16:00:00.000Z", "sanity: this hook's own record has already ended");

    const NEXT_SERVICE: ServiceTimeline = { ...LIVE, serviceKey: "svc-next", startedAt: "2026-09-27T18:00:00.000Z" };
    await act(async () => {
      FakeEventSource.last!.push("service-timeline:history", NEXT_SERVICE);
      await settle();
      await settle();
    });
    assert.equal(result.current?.serviceKey, "svc-next", "nothing live left to protect, so the next service's own push must go through");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a LATER service's ended record replaces a stale open one this hook was handed", async () => {
  // A display reconnecting after both services ran: the replayed frame is the
  // 9:00 still open (it was, when that frame was sent), and the read that
  // corrects it answers the 11:00, since ended. The 11:00 started after the
  // record this hook holds, so it is newer news, not a History edit of the past.
  const LATER_ENDED: ServiceTimeline = {
    ...LIVE,
    serviceKey: "svc-eleven",
    startedAt: "2026-09-27T17:00:00.000Z",
    endedAt: "2026-09-27T18:10:00.000Z",
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/service-timeline/current")) return okResponse(LIVE);
    return okResponse({});
  }) as unknown as typeof fetch;
  try {
    const { result } = renderHook(() => useServiceTimeline());
    await act(async () => {
      await settle();
      await settle();
    });
    assert.equal(result.current?.serviceKey, "svc-live", "sanity: holding the open record");

    await act(async () => {
      FakeEventSource.last!.push("service-timeline:history", LATER_ENDED);
      await settle();
      await settle();
    });
    assert.equal(
      result.current?.serviceKey,
      "svc-eleven",
      `stuck on a stale open record (${result.current?.serviceKey}) after a later service's own record arrived`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
