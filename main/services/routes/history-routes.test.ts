// POST /api/service-timeline/current/reset-pacing — an operator's escape hatch
// for a service that has been running long: items before the reset stop
// counting toward the pacing readout (see renderer/main/service-pacing.ts).
//
// Driven through the route with the recorder's `current` set directly (the
// route mutates the SAME object getCurrent() returns), because what's under
// test is the route's live/not-live branching and its side effects — not the
// recorder's own record lifecycle, which service-timeline-recorder.test.ts and
// recorder-forget.test.ts already cover.

import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-reset-pacing-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { addBroadcastListener } = await import("../broadcaster.js");

type Rec = { serviceKey: string; startedAt: string; endedAt: string | null; pacingResetAt?: string | null; items: unknown[] };
type Held = { current: Rec | null };
const rec = serviceTimelineRecorder as unknown as Held;

const broadcasts: { channel: string; payload: unknown }[] = [];
addBroadcastListener((channel, payload) => {
  broadcasts.push({ channel, payload });
});

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("POST /api/service-timeline/current/reset-pacing", () => {
  beforeEach(() => {
    rec.current = null;
    broadcasts.length = 0;
  });

  it("sets pacingResetAt on the live record and broadcasts it", async () => {
    rec.current = {
      serviceKey: "st1:plan:11am",
      startedAt: "2026-09-06T11:00:00.000Z",
      endedAt: null,
      pacingResetAt: null,
      items: [],
    };
    const before = Date.now();

    const out = await callRoute(historyRoutes, "/api/service-timeline/current/reset-pacing", { method: "POST" });

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    const json = out.json as Rec;
    assert.ok(json.pacingResetAt, "response record has no pacingResetAt");
    assert.ok(Date.parse(json.pacingResetAt!) >= before, "pacingResetAt is not a fresh timestamp");
    // Mutated in place — the recorder's own copy carries the reset too, so the
    // next debounced persist does not silently drop it.
    assert.equal(rec.current!.pacingResetAt, json.pacingResetAt);

    const tlBroadcasts = broadcasts.filter((b) => b.channel === "service-timeline:history");
    assert.equal(tlBroadcasts.length, 1, "expected exactly one service-timeline:history broadcast");
    assert.equal((tlBroadcasts[0]!.payload as Rec).pacingResetAt, json.pacingResetAt);
  });

  it("answers 409 when no service is live", async () => {
    rec.current = null; // nothing recording

    const out = await callRoute(historyRoutes, "/api/service-timeline/current/reset-pacing", { method: "POST" });

    assert.equal(out.status, 409, `expected 409, got ${out.status}: ${out.body}`);
    assert.equal(broadcasts.length, 0, "must not broadcast when refusing");
  });

  it("also answers 409 when the last record is closed (endedAt set)", async () => {
    rec.current = {
      serviceKey: "st1:plan:11am",
      startedAt: "2026-09-06T11:00:00.000Z",
      endedAt: "2026-09-06T12:30:00.000Z", // finalised — not live
      pacingResetAt: null,
      items: [],
    };

    const out = await callRoute(historyRoutes, "/api/service-timeline/current/reset-pacing", { method: "POST" });

    assert.equal(out.status, 409);
  });
});
