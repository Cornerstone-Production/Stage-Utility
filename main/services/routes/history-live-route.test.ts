// history-live-route.test.ts — GET /api/history/live, the read-only "is this
// service recording right now" question a client asks BEFORE offering an
// action the server would otherwise refuse.
//
// Answers straight off isServiceLive, the SAME expression assertNotLive
// throws on — proven here by driving the real recorder into a live state and
// checking the two never disagree, rather than asserting against a second,
// hand-written notion of "live". isServiceLive is `RECORDERS.some(r =>
// r.isRecording(key))` over ALL THREE recorders (timeline, attendance, SPL) —
// proven below by making EACH ONE, on its own, the sole reason the answer is
// "live", so a route that only actually checked one of the three would fail
// here rather than merely fail to be exercised.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-live-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { attendanceRecorder } = await import("../attendance-recorder.js");
const { splRecorder } = await import("../spl-recorder.js");
const { assertNotLive, ServiceIsLiveError } = await import("../history-edit.js");

const KEY = "st1:plan-live:t-1";

// The three recorders all extend the same ServiceRecorder base class and
// share this shape (`currentKey`/`current`/`lastLiveAt`), which is what
// `isRecording` reads — see service-recorder.ts. `current` only has to be
// truthy for `isRecording`'s own check; the recorders' real record shapes
// differ, but nothing here calls anything but `isRecording`.
type Held = { current: unknown; currentKey: string | null; lastLiveAt: number };
const RECORDERS = [
  ["timeline", serviceTimelineRecorder] as const,
  ["attendance", attendanceRecorder] as const,
  ["spl", splRecorder] as const,
];

function goLiveOn(recorder: unknown, key: string): void {
  const r = recorder as Held;
  r.current = { serviceKey: key, endedAt: null };
  r.currentKey = key;
  r.lastLiveAt = Date.now();
}

function idleOn(recorder: unknown): void {
  const r = recorder as Held;
  r.current = null;
  r.currentKey = null;
  r.lastLiveAt = 0;
}

function idleAll(): void {
  for (const [, r] of RECORDERS) idleOn(r);
}

after(async () => {
  idleAll();
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("GET /api/history/live", () => {
  beforeEach(() => idleAll());

  it("requires a serviceKey", async () => {
    const out = await callRoute(historyRoutes, "/api/history/live");
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
  });

  it("answers false for a service nothing is recording", async () => {
    const out = await callRoute(historyRoutes, `/api/history/live?serviceKey=${encodeURIComponent(KEY)}`);
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual(out.json, { live: false });
  });

  for (const [name, recorder] of RECORDERS) {
    it(`answers true when the ${name} recorder alone is live, and agrees with assertNotLive on the same key`, async () => {
      goLiveOn(recorder, KEY);
      try {
        const out = await callRoute(historyRoutes, `/api/history/live?serviceKey=${encodeURIComponent(KEY)}`);
        assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
        assert.deepEqual(out.json, { live: true }, `the ${name} recorder alone being live did not answer live`);
        assert.throws(
          () => assertNotLive(KEY, "rebuilt"),
          ServiceIsLiveError,
          `the route answered live from the ${name} recorder but assertNotLive did not refuse — the two disagreed`,
        );
      } finally {
        idleOn(recorder);
      }
    });
  }

  it("answers false for a DIFFERENT key while one service is live", async () => {
    goLiveOn(serviceTimelineRecorder, KEY);
    try {
      const out = await callRoute(historyRoutes, "/api/history/live?serviceKey=some-other-service");
      assert.deepEqual(out.json, { live: false });
    } finally {
      idleOn(serviceTimelineRecorder);
    }
  });

  it("answers false again once the live service ends", async () => {
    goLiveOn(serviceTimelineRecorder, KEY);
    (serviceTimelineRecorder as unknown as { current: { endedAt: string | null } }).current.endedAt = new Date().toISOString();
    const out = await callRoute(historyRoutes, `/api/history/live?serviceKey=${encodeURIComponent(KEY)}`);
    assert.deepEqual(out.json, { live: false }, "a service with endedAt set must read as not live");
  });
});
