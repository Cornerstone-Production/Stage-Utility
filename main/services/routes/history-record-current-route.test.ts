// GET /api/attendance/history/:key and GET /api/service-timeline/:key — one
// service's record, as the History service page reads it.
//
// Both recorders persist on a debounce (service-recorder.ts schedulePersist),
// so the store lags the recorder by up to one interval: a service started
// seconds ago reads null, and a live one reads the copy from the last write.
// The live record is the recorder's own, so the route answers that when the
// key is the service being recorded — the same preference the SPL route and
// the baptism lane already give theirs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-record-current-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { attendanceStore } = await import("../attendance-store.js");
const { attendanceRecorder } = await import("../attendance-recorder.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");

type Held = { current: Record<string, unknown> | null };

function identity(serviceKey: string, planTitle: string) {
  return {
    serviceKey,
    serviceTypeId: "st-1",
    serviceTypeName: "Weekend",
    planId: "909",
    planTitle,
    seriesTitle: null,
    serviceDate: "2026-09-27",
    serviceTimeId: "2251",
    serviceTimeStartsAt: null,
    startedAt: "2026-09-27T14:00:00.000Z",
    endedAt: null,
  };
}

const CASES = [
  {
    name: "attendance",
    path: "/api/attendance/history/",
    recorder: attendanceRecorder as unknown as Held,
    store: attendanceStore as unknown as { get(k: string): Promise<unknown>; upsert(r: never): Promise<void> },
    record: (key: string, planTitle: string) => ({ ...identity(key, planTitle), samples: [] }),
  },
  {
    name: "service timeline",
    path: "/api/service-timeline/",
    recorder: serviceTimelineRecorder as unknown as Held,
    store: serviceTimelineStore as unknown as { get(k: string): Promise<unknown>; upsert(r: never): Promise<void> },
    record: (key: string, planTitle: string) => ({ ...identity(key, planTitle), items: [] }),
  },
];

for (const c of CASES) {
  describe(`GET ${c.path}:key`, () => {
    it("answers the recorder's live record when its key matches, ahead of the debounced write", async () => {
      const key = `st-1:909:${c.name.length}01`;
      await c.store.upsert(c.record(key, "Written at the last persist") as never);
      c.recorder.current = c.record(key, "Live in the recorder");
      try {
        const out = await callRoute(historyRoutes, `${c.path}${encodeURIComponent(key)}`);
        assert.equal(out.status, 200);
        assert.equal(
          (out.json as { planTitle?: string } | null)?.planTitle,
          "Live in the recorder",
          `${c.name}: answered the store's older copy instead of the recorder's live record`,
        );
      } finally {
        c.recorder.current = null;
      }
    });

    it("answers the store once the recorder's copy of that service has ended", async () => {
      // A closed record is on disk already (the recorder persists it as it
      // closes), and the store may since hold a newer copy — an archive import
      // into that key, say. Only a record still recording can be ahead of it.
      const key = `st-1:909:${c.name.length}03`;
      await c.store.upsert(c.record(key, "Imported since") as never);
      c.recorder.current = { ...c.record(key, "Closed in the recorder"), endedAt: "2026-09-27T16:00:00.000Z" };
      try {
        const out = await callRoute(historyRoutes, `${c.path}${encodeURIComponent(key)}`);
        assert.equal(
          (out.json as { planTitle?: string }).planTitle,
          "Imported since",
          `${c.name}: a closed in-memory record shadowed the store's newer copy`,
        );
      } finally {
        c.recorder.current = null;
      }
    });

    it("answers the store when the recorder is holding a different service", async () => {
      const key = `st-1:909:${c.name.length}02`;
      await c.store.upsert(c.record(key, "Stored") as never);
      c.recorder.current = c.record("st-1:909:elsewhere", "Some other service");
      try {
        const out = await callRoute(historyRoutes, `${c.path}${encodeURIComponent(key)}`);
        assert.equal((out.json as { planTitle?: string }).planTitle, "Stored");
      } finally {
        c.recorder.current = null;
      }
    });
  });
}
