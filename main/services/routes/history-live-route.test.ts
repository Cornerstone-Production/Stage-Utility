// history-live-route.test.ts — GET /api/history/live, the read-only "is this
// service recording right now" question a client asks BEFORE offering an
// action the server would otherwise refuse (Ruling 60 / C2).
//
// Answers straight off isServiceLive, the SAME expression assertNotLive
// throws on — proven here by driving the real recorder into a live state and
// checking the two never disagree, rather than asserting against a second,
// hand-written notion of "live".

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
const { assertNotLive, ServiceIsLiveError } = await import("../history-edit.js");

const KEY = "st1:plan-live:t-1";

type Held = { current: { serviceKey: string; endedAt: string | null } | null; currentKey: string | null; lastLiveAt: number };

function goLive(key: string): void {
  const r = serviceTimelineRecorder as unknown as Held;
  r.current = { serviceKey: key, endedAt: null };
  r.currentKey = key;
  r.lastLiveAt = Date.now();
}

function idle(): void {
  const r = serviceTimelineRecorder as unknown as Held;
  r.current = null;
  r.currentKey = null;
  r.lastLiveAt = 0;
}

after(async () => {
  idle();
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("GET /api/history/live", () => {
  beforeEach(() => idle());

  it("requires a serviceKey", async () => {
    const out = await callRoute(historyRoutes, "/api/history/live");
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
  });

  it("answers false for a service nothing is recording", async () => {
    const out = await callRoute(historyRoutes, `/api/history/live?serviceKey=${encodeURIComponent(KEY)}`);
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual(out.json, { live: false });
  });

  it("answers true for a service the recorder is actively writing, and agrees with assertNotLive on the same key", async () => {
    goLive(KEY);
    try {
      const out = await callRoute(historyRoutes, `/api/history/live?serviceKey=${encodeURIComponent(KEY)}`);
      assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
      assert.deepEqual(out.json, { live: true });
      assert.throws(() => assertNotLive(KEY, "rebuilt"), ServiceIsLiveError, "the route answered live but assertNotLive did not refuse — the two disagreed");
    } finally {
      idle();
    }
  });

  it("answers false for a DIFFERENT key while one service is live", async () => {
    goLive(KEY);
    try {
      const out = await callRoute(historyRoutes, "/api/history/live?serviceKey=some-other-service");
      assert.deepEqual(out.json, { live: false });
    } finally {
      idle();
    }
  });

  it("answers false again once the live service ends", async () => {
    goLive(KEY);
    const r = serviceTimelineRecorder as unknown as Held;
    r.current!.endedAt = new Date().toISOString();
    const out = await callRoute(historyRoutes, `/api/history/live?serviceKey=${encodeURIComponent(KEY)}`);
    assert.deepEqual(out.json, { live: false }, "a service with endedAt set must read as not live");
  });
});
