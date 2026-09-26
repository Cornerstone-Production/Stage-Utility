// GET /api/spl/history/:key — the SPL history record for one service.
//
// The store persists on a 60s debounce (spl-recorder.ts), so a service that
// started seconds ago has no record in the store yet. Answering from the
// store alone reads that gap as "no sound recorded" — the row shows the flash
// for up to a minute after a fresh service starts, and again for up to a
// minute after a restart's resume-rebuild. Driven through the real route and
// the real recorder singleton (not a stub), because what is under test is
// exactly the gap between what the recorder holds in memory and what has
// reached disk — the same gap baptismLaneFor (history-routes.ts) already
// closes for the timeline recorder.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-spl-history-current-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { statusRoutes } = await import("./status-routes.js");
const { callRoute } = await import("./route-harness.js");
const { splHistoryStore } = await import("../spl-history-store.js");
const { splRecorder } = await import("../spl-recorder.js");

type Held = { current: { serviceKey: string; endedAt: string | null; meterId: string | null } | null };
const recorder = splRecorder as unknown as Held;

function record(serviceKey: string, meterId: string | null) {
  return {
    serviceKey,
    serviceTypeId: "75953",
    serviceTypeName: "The Salt Company",
    planId: "909",
    planTitle: "Night of Worship",
    seriesTitle: null,
    serviceDate: "2026-09-27",
    serviceTimeId: "2251",
    serviceTimeStartsAt: null,
    meterId,
    metricKey: null,
    startedAt: "2026-09-27T14:00:00.000Z",
    endedAt: null,
    items: [],
  };
}

async function get(key: string) {
  return callRoute(statusRoutes, `/api/spl/history/${encodeURIComponent(key)}`);
}

describe("GET /api/spl/history/:key", () => {
  it("answers the recorder's live record when its key matches, before the persist debounce has written it", async () => {
    const key = "75953:909:2251";
    recorder.current = record(key, "meter-1") as never;
    try {
      assert.equal(await splHistoryStore.get(key), null, "sanity: the store has not seen this service yet");
      const out = await get(key);
      assert.equal(out.status, 200);
      assert.equal(
        (out.json as { meterId: string | null } | null)?.meterId,
        "meter-1",
        "answered the store's null instead of the recorder's live record",
      );
    } finally {
      recorder.current = null;
    }
  });

  it("still answers the store when the recorder is holding a DIFFERENT key", async () => {
    const key = "75953:909:2252";
    await splHistoryStore.upsert(record(key, "meter-2") as never);
    recorder.current = record("75953:909:elsewhere", "meter-3") as never;
    try {
      const out = await get(key);
      assert.equal(out.status, 200);
      assert.equal((out.json as { meterId: string | null }).meterId, "meter-2");
    } finally {
      recorder.current = null;
    }
  });

  it("answers null for a key no record names and the recorder is not holding", async () => {
    recorder.current = null;
    const out = await get("nope:nope:nope");
    assert.equal(out.status, 200);
    assert.equal(out.json, null);
  });
});
