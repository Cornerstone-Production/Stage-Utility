// baptism-rebuild-route.test.ts — POST /api/baptism/rebuild, driven end to end
// against the real route, the real stores and a real archive file.
//
// The merge rule itself (matched vs. added vs. kept, the 2-second skew
// tolerance, and that it never deletes) is proven in
// rebuild-baptism-merge.test.ts; this proves the HTTP surface around it: body
// validation, the live refusal, the no-raw-rows refusal, and that a
// successful call actually lands on disk through the real dispatcher.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-rebuild-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { baptismStore } = await import("../baptism-store.js");
const { serviceDirPath } = await import("../archive/archive-paths.js");

const KEY = "st1:plan-1:bap-route";
const DATE = "2026-09-20";

function timeline() {
  return {
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "t-1",
    serviceTimeStartsAt: null,
    startedAt: `${DATE}T09:00:00.000Z`,
    endedAt: `${DATE}T10:30:00.000Z`,
    items: [],
  };
}

const BAPTISM_CSV = [
  "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail",
  "2026-09-20T09:40:00.000Z,start,per-person,testimony,1,0,0,,,",
  "2026-09-20T09:42:00.000Z,testimony-end,per-person,testimony,1,0,120000,,,",
  "2026-09-20T09:42:00.000Z,finish,per-person,testimony,1,0,0,,,",
  "",
].join("\n");

after(async () => {
  serviceTimelineRecorder.forget(KEY);
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("POST /api/baptism/rebuild", () => {
  beforeEach(async () => {
    serviceTimelineRecorder.forget(KEY);
    await serviceTimelineStore.upsert(timeline() as never);
    for (const s of (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY)) {
      await baptismStore.deleteSession(s.id);
    }
    await fs.rm(serviceDirPath(KEY, DATE), { recursive: true, force: true });
  });

  it("rejects a body with no serviceKey", async () => {
    const out = await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: {} });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
  });

  it("refuses with 409 when the service has no baptism.csv at all", async () => {
    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "a service with no baptism archive answered as though it rebuilt something");
    assert.equal(handlerErrorStatus(thrown), 409);
    assert.match((thrown as Error).message, /No raw rows exist for this recording/);
  });

  it("refuses with a sentence while that service is recording", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "baptism.csv"), BAPTISM_CSV, "utf8");

    const held = serviceTimelineRecorder as unknown as {
      current: unknown;
      currentKey: string | null;
      lastLiveAt: number;
    };
    held.current = { serviceKey: KEY, endedAt: null, items: [] };
    held.currentKey = KEY;
    held.lastLiveAt = Date.now();

    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } catch (err) {
      thrown = err;
    } finally {
      serviceTimelineRecorder.forget(KEY);
    }

    assert.ok(thrown, "the route did not refuse a live service");
    assert.equal(handlerErrorStatus(thrown), 409);
    assert.equal(
      (thrown as Error).message,
      "That service is recording right now — it cannot be rebuilt until it ends.",
    );
    assert.equal((await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY).length, 0, "a refused rebuild wrote anyway");
  });

  it("rebuilds a session from the raw rows, on disk, through the real route", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "baptism.csv"), BAPTISM_CSV, "utf8");

    const out = await callRoute(historyRoutes, "/api/baptism/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual(out.json, { rows: 3, sessions: 1, updated: 0, added: 1, kept: 0 });

    const sessions = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);
    assert.equal(sessions.length, 1, "the rebuilt session did not land in the store");
    assert.equal(sessions[0]!.title, "Sunday Gathering", "identity comes from the timeline record");
    assert.equal(sessions[0]!.people.length, 1);
    assert.equal(sessions[0]!.people[0]!.testimonyMs, 120_000);
  });

  it("a second rebuild of the same rows changes nothing new (idempotent)", async () => {
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "baptism.csv"), BAPTISM_CSV, "utf8");

    await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY } });
    const second = await callRoute(historyRoutes, "/api/baptism/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });

    assert.equal(second.status, 200, `expected 200, got ${second.status}: ${second.body}`);
    assert.deepEqual(second.json, { rows: 3, sessions: 1, updated: 1, added: 0, kept: 0 });
    assert.equal((await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY).length, 1, "a re-run duplicated the session");
  });
});
