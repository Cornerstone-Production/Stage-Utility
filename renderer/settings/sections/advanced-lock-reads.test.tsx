// advanced-lock-reads.test.tsx — the Advanced page must not re-read the update
// lock on every message of a live channel.
//
// The bug: the effect that watches "pco:live", "spl:history",
// "attendance:history" and "service-timeline:history" called GET
// /api/update/lock from EVERY notification on all four channels, ignoring the
// `replayed` flag `onNotification` hands it. All four are hydrated channels
// (see sse-channels.ts), so a mount into an already-open SSE stream replays
// each one's cached frame at once — 4 replays + the mount's own direct read =
// 5 reads every time the page opened (measured in prod, 27 Sep 2026). Worse,
// pco:live keeps broadcasting during a live service (an item change, or a 15s
// keepalive) whether or not the fact the lock depends on — a PCO item live, or
// a recorder's record open — has changed, so the page asked the server for the
// lock roughly once every few seconds for as long as it stayed open.
//
// The fix derives the one fact each channel's payload carries that the
// server's lock (serviceActivity() in system-routes.ts) actually depends on —
// pco:live's `mode === "item"`, and each recorder's `endedAt == null` — and
// reads the lock again only when a LIVE (non-replayed) frame changes that
// fact from what was last known.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import type { UpdateStatus } from "@main/types/state";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { UpdatesPanel } = await import("./advanced-section.js");
const { ConfirmHost, TooltipProvider } = await import("../../components/ui/index.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
// The stream replays each channel's last frame to a late subscriber, so a push
// in one case would be one more lock read in the next.
afterEach(async () => {
  cleanup();
  await settle();
  resetReplayCache();
});

const STATUS = {
  isGitRepo: true,
  canUpdate: true,
  selfRecovers: true,
  branch: "beta",
  tracks: ["beta", "main"],
  version: "9.9.9",
  currentSha: "aaaaaaa",
  currentDate: "2020-01-01T00:00:00.000Z",
  behind: 0,
  behindUserFacing: 0,
  currentTag: "v9.9.9",
  targetTag: "v9.9.9",
  releasesBehind: 0,
  tagBased: true,
  latestSha: "aaaaaaa",
  latestDate: "2020-01-01T00:00:00.000Z",
  changelog: [],
  lastCheckedAt: "2020-01-02T00:00:00.000Z",
  phase: "idle",
  step: null,
  restartPending: false,
  lastResult: null,
  error: null,
} as unknown as UpdateStatus;

/** Every request the running test cares about — /api/update/lock only. A live
 *  SSE round trip can fire other GETs (none for this panel today, but the
 *  count must never silently start including one). */
function stubFetch() {
  let lockReads = 0;
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/update/lock")) {
      lockReads++;
      return ok({ active: false, reasons: [] });
    }
    return ok({});
  });
  return { ...f, lockReads: () => lockReads };
}

async function mount(): Promise<void> {
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(UpdatesPanel, {
        updateStatus: STATUS,
        autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
        handlers: {
          handleCheckUpdates: async () => {},
          handleApplyUpdate: async () => {},
          handleSetAutoUpdate: async () => {},
        } as unknown as Parameters<typeof UpdatesPanel>[0]["handlers"],
      }),
      React.createElement(ConfirmHost, null),
    ),
  );
  await settle();
  await settle();
}

/** A closed (not recording) history record — the shape spl:history,
 *  attendance:history and service-timeline:history alike push, sharing the
 *  `endedAt` field ServiceRecord declares. */
function closedRecord(serviceKey: string) {
  return { serviceKey, endedAt: "2020-01-01T00:00:00.000Z" };
}
function openRecord(serviceKey: string) {
  return { serviceKey, endedAt: null };
}
function pcoLive(mode: "item" | "preservice" | "none") {
  return { mode, currentItemId: null, serverNow: new Date().toISOString() };
}

test("mount reads the lock once; the four channels replaying on a warm cache read it no more", async () => {
  const f = stubFetch();
  try {
    // A DECOY subscriber, mounted first so it becomes the "first" listener on
    // each channel and its push both reaches it live AND warms the client-side
    // replay cache (renderer/lib/api.ts's lastPayload) — exactly what a page
    // navigated to Advanced from elsewhere in the app, over an SSE stream
    // that has been open a while, finds already true.
    await mount();
    FakeEventSource.last!.push("pco:live", pcoLive("none"));
    FakeEventSource.last!.push("spl:history", closedRecord("svc-1"));
    FakeEventSource.last!.push("attendance:history", closedRecord("svc-1"));
    FakeEventSource.last!.push("service-timeline:history", closedRecord("svc-1"));
    await settle();
    cleanup();
    await settle();

    const before = f.lockReads();
    // The real mount under test — every one of the four channels above now has
    // a cached frame, so onNotification hands it to this mount as a replay.
    await mount();
    assert.equal(f.lockReads() - before, 1, "exactly one read on mount, not five");
  } finally {
    f.restore();
  }
});

test("repeated same-state pco:live frames cause no further reads", async () => {
  const f = stubFetch();
  try {
    await mount();
    FakeEventSource.last!.push("pco:live", pcoLive("none"));
    await settle();
    cleanup();
    await settle();

    const afterMountReads = f.lockReads();
    // Same fact (mode "none" both times) — the lock cannot have moved.
    for (let i = 0; i < 3; i++) {
      FakeEventSource.last!.push("pco:live", pcoLive("none"));
      await settle();
    }
    assert.equal(f.lockReads(), afterMountReads, "an unchanged pco:live fact must not re-read the lock");
  } finally {
    f.restore();
  }
});

test("a live-to-idle transition reads the lock exactly once more", async () => {
  const f = stubFetch();
  try {
    // Warm the cache on a decoy mount, then tear it down — the pushes below
    // must land on the SECOND (real) mount, not on a subscriber that is
    // already gone.
    await mount();
    FakeEventSource.last!.push("pco:live", pcoLive("none"));
    await settle();
    cleanup();
    await settle();

    // The real mount under test: replay hands it "none" as its starting fact.
    await mount();
    let reads = f.lockReads();
    FakeEventSource.last!.push("pco:live", pcoLive("item"));
    await settle();
    assert.equal(f.lockReads(), reads + 1, "idle-to-live is a transition and must read once");

    reads = f.lockReads();
    // The transition under test: live -> idle.
    FakeEventSource.last!.push("pco:live", pcoLive("none"));
    await settle();
    assert.equal(f.lockReads(), reads + 1, "live-to-idle must read the lock exactly once more");

    // And holding at idle must not read again.
    reads = f.lockReads();
    FakeEventSource.last!.push("pco:live", pcoLive("none"));
    await settle();
    assert.equal(f.lockReads(), reads, "holding at idle must not re-read");
  } finally {
    f.restore();
  }
});

test("a recorder's record closing (endedAt set) reads the lock once", async () => {
  const f = stubFetch();
  try {
    await mount();
    FakeEventSource.last!.push("spl:history", openRecord("svc-2"));
    await settle();
    cleanup();
    await settle();

    await mount();
    const reads = f.lockReads();
    FakeEventSource.last!.push("spl:history", closedRecord("svc-2"));
    await settle();
    assert.equal(f.lockReads(), reads + 1, "a record ending is a transition the lock depends on");
  } finally {
    f.restore();
  }
});
