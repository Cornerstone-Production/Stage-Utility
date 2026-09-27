// history-rebuild-cap-e2e.test.tsx — the whole-service Rebuild from raw
// (rebuildServiceRecords), driven against the REAL baptism store at the
// MAX_SESSIONS cap and the REAL describeRebuild — not a stubbed fetch
// answering a hand-set `full`.
//
// The standalone /api/baptism/rebuild route has its own cap tests
// (rebuild-baptism-merge.test.ts, baptism-store.test.ts). rebuildServiceRecords'
// OWN wiring of `full` — its write closure in history-edit.ts, separate code
// from the standalone route's — had no guard of its own: hard-coding `full: 0`
// there left every existing whole-service-rebuild test green, since none of
// them ever fill the store to the cap.

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-rebuild-cap-e2e-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import { installRenderDom } from "../../test-dom.js";
const teardown = installRenderDom();
after(() => teardown());

const { serviceTimelineStore } = await import("../../../main/services/service-timeline-store.js");
const { attendanceStore } = await import("../../../main/services/attendance-store.js");
const { splHistoryStore } = await import("../../../main/services/spl-history-store.js");
const { serviceDirPath } = await import("../../../main/services/archive/archive-paths.js");
const { baptismStore, MAX_SESSIONS } = await import("../../../main/services/baptism-store.js");
const { rebuildServiceRecords } = await import("../../../main/services/history-edit.js");
const { describeRebuild } = await import("./service-history-section.js");

const KEY = "st1:cap-e2e:t-1";
const DATE = "2026-09-23";

test("rebuildServiceRecords reports how many baptism sessions the store had no room for, and History's own clause names it", async () => {
  await serviceTimelineStore.upsert({
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "cap-e2e",
    planTitle: "Cap E2E Service",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "t-1",
    serviceTimeStartsAt: null,
    startedAt: "2026-09-23T09:00:00.000Z",
    endedAt: "2026-09-23T10:30:00.000Z",
    items: [], // no events.csv at all — nothing for the timeline leg to derive
  } as never);
  await attendanceStore.delete(KEY);
  await splHistoryStore.delete(KEY);

  // Fill the store to the cap with sessions for OTHER services — none of
  // this rebuild's own business, and a rebuild never evicts an existing
  // session to make room, so every one of them must survive untouched.
  const filler = Array.from({ length: MAX_SESSIONS }, (_, i) => {
    const at = new Date(Date.parse("2037-01-01T00:00:00.000Z") + i * 86_400_000).toISOString();
    return {
      id: `bap-${Date.parse(at)}`,
      startedAt: at,
      finishedAt: at,
      people: [{ testimonyMs: 1, baptizeMs: 1 }],
      title: null,
      serviceTypeId: null,
      planId: null,
      serviceKey: `cap-e2e-filler-${i}`,
    };
  });
  await baptismStore.addSessions(filler as never);
  assert.equal((await baptismStore.listSessions()).length, MAX_SESSIONS, "precondition: the store is at the cap");

  const dir = serviceDirPath(KEY, DATE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "baptism.csv"),
    [
      "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail",
      "2026-09-23T09:40:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-23T09:42:00.000Z,testimony-end,per-person,testimony,1,0,120000,,,",
      "2026-09-23T09:42:00.000Z,finish,per-person,testimony,1,0,120000,,,",
      "",
    ].join("\n"),
    "utf8",
  );

  const outcome = await rebuildServiceRecords(KEY);

  assert.equal(outcome.baptism.rebuilt, false, "the store is full — nothing could be added, so nothing was rebuilt");
  assert.ok(outcome.baptismDetail, "the baptism leg must report its own detail — baptism.csv exists");
  assert.equal(outcome.baptismDetail!.added, 0);
  assert.equal(outcome.baptismDetail!.full, 1, "one new session had no room in a store already at the cap");

  const shown = describeRebuild(outcome);
  assert.match(
    shown,
    /the store is full, so 1 baptism sessions were not added/,
    `History's own clause must name the full store: ${shown}`,
  );

  const all = await baptismStore.listSessions();
  assert.equal(all.length, MAX_SESSIONS, "the cap still holds — nothing evicted to make room");
  assert.equal(
    all.filter((s) => (s.serviceKey ?? "").startsWith("cap-e2e-filler-")).length,
    MAX_SESSIONS,
    "every filler session must still be there",
  );
});
