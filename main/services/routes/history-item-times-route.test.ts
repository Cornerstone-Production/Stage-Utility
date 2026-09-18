// POST /api/history/item-times — correcting one item's recorded start/end.
//
// Driven through the REAL route with a REAL store on a temp data dir, because
// the failure this has to rule out is a path through the pieces rather than a
// piece: the store write, the overlay, the broadcast and the answer all have to
// agree, and unit tests over applyItemTimeEdits cannot see a route that saves
// and then answers a raw record.
//
// The recorders are put live/idle by hand, as history-edit.test.ts does — the
// lock is what is under test, and driving a PCO tick to get there would test the
// poller instead.

import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ServiceTimeline } from "../../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-item-times-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { attendanceRecorder } = await import("../attendance-recorder.js");
const { splRecorder } = await import("../spl-recorder.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { errorMessage } = await import("../errors.js");
const { serviceDirPath } = await import("../archive/archive-paths.js");

const KEY = "st1:plan9:evening";
const WINDOW_START = "2026-09-17T20:15:00.000Z";
const WINDOW_END = "2026-09-17T21:45:00.000Z";
const PREROLL_END = "2026-09-17T20:26:22.000Z"; // 11:22, as recorded
const FIXED_END = "2026-09-17T20:17:00.000Z"; //    2:00, as it ran

type Held = { current: Record<string, unknown> | null; currentKey: string | null; lastLiveAt: number; persistTimer: ReturnType<typeof setTimeout> | null; dirty: boolean };
const RECORDERS = [attendanceRecorder, splRecorder, serviceTimelineRecorder] as unknown as Held[];

function idle() {
  for (const r of RECORDERS) {
    if (r.persistTimer) clearTimeout(r.persistTimer);
    r.current = null;
    r.currentKey = null;
    r.lastLiveAt = 0;
    r.persistTimer = null;
    r.dirty = false;
  }
}
function goLive() {
  for (const r of RECORDERS) {
    r.current = { serviceKey: KEY, endedAt: null };
    r.currentKey = KEY;
    r.lastLiveAt = Date.now();
  }
}

const broadcasts: { channel: string; payload: unknown }[] = [];
addBroadcastListener((channel, payload) => broadcasts.push({ channel, payload }));

async function seed(): Promise<void> {
  await serviceTimelineStore.upsert({
    serviceKey: KEY,
    serviceTypeId: "st1",
    planId: "plan9",
    planTitle: "Evening",
    seriesTitle: null,
    serviceDate: "2026-09-17",
    serviceTimeId: "evening",
    serviceTimeStartsAt: WINDOW_START,
    startedAt: WINDOW_START,
    endedAt: WINDOW_END,
    items: [
      { itemId: "vid-1", title: "VIDEO: Pre-roll", sequence: 0, plannedLengthSec: 120, startedAt: WINDOW_START, endedAt: PREROLL_END, actualDurationSec: 682 },
      { itemId: "wel-1", title: "Welcome", sequence: 1, plannedLengthSec: 300, startedAt: PREROLL_END, endedAt: "2026-09-17T20:31:22.000Z", actualDurationSec: 300 },
    ],
  } as ServiceTimeline);
}

/**
 * The route, answering the way a client sees it.
 *
 * callRoute stops at the route module, but a refusal here is a THROW that the
 * dispatcher turns into a status — so a test reading only what the handler wrote
 * would report every refusal as "no response" and prove nothing. Routed through
 * the dispatcher's own exported handlerErrorStatus rather than a second copy of
 * the mapping, which is what that export is for.
 */
async function post(body: unknown) {
  try {
    return await callRoute(historyRoutes, "/api/history/item-times", { method: "POST", body });
  } catch (err) {
    const message = errorMessage(err);
    return { status: handlerErrorStatus(err), body: message, json: { error: message } };
  }
}

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("POST /api/history/item-times", () => {
  beforeEach(async () => {
    idle();
    broadcasts.length = 0;
    await serviceTimelineStore.delete(KEY);
    await seed();
  });

  it("applies an end correction, answers the effective record and keeps the raw one", async () => {
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    const answered = out.json as ServiceTimeline;
    assert.equal(answered.items[0].endedAt, FIXED_END);
    assert.equal(answered.items[0].actualDurationSec, 120, "the answer is the EFFECTIVE record");
    assert.deepEqual(answered.items[0].editedFrom, {
      startedAt: WINDOW_START,
      endedAt: PREROLL_END,
      actualDurationSec: 682,
    });

    const stored = (await serviceTimelineStore.get(KEY))!;
    assert.equal(stored.items[0].endedAt, PREROLL_END, "the stored item still says what the recorder saw");
    assert.equal(stored.items[0].editedFrom, undefined, "the overlay is not persisted");
    assert.deepEqual(
      stored.itemTimeEdits?.map((e) => ({ itemId: e.itemId, sequence: e.sequence, endedAt: e.endedAt })),
      [{ itemId: "vid-1", sequence: 0, endedAt: FIXED_END }],
    );
  });

  it("broadcasts the EFFECTIVE record, not the stored one", async () => {
    await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });
    const pushed = broadcasts.filter((b) => b.channel === "service-timeline:history");
    assert.equal(pushed.length, 1, "expected exactly one service-timeline:history broadcast");
    assert.equal((pushed[0]!.payload as ServiceTimeline).items[0].actualDurationSec, 120);
  });

  it("the neighbour is untouched — the gap is left where the operator can see it", async () => {
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });
    const answered = out.json as ServiceTimeline;
    assert.equal(answered.items[1].startedAt, PREROLL_END);
    assert.equal(answered.items[1].actualDurationSec, 300);
  });

  it("a GET of the record afterwards carries the correction too", async () => {
    await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });

    const one = await callRoute(historyRoutes, `/api/service-timeline/${encodeURIComponent(KEY)}`);
    assert.equal((one.json as ServiceTimeline).items[0].actualDurationSec, 120);

    const all = await callRoute(historyRoutes, "/api/service-timeline");
    const mine = (all.json as ServiceTimeline[]).find((r) => r.serviceKey === KEY)!;
    assert.equal(mine.items[0].actualDurationSec, 120, "the LIST route must overlay too");
  });

  it("null clears the override and the row goes back to what was recorded", async () => {
    await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: null });

    assert.equal(out.status, 200, out.body);
    const answered = out.json as ServiceTimeline;
    assert.equal(answered.items[0].endedAt, PREROLL_END);
    assert.equal(answered.items[0].actualDurationSec, 682);
    assert.equal(answered.items[0].editedFrom, undefined, "no stale edited marker");
    const stored = (await serviceTimelineStore.get(KEY))!;
    assert.equal(stored.itemTimeEdits, undefined, "the edit is gone from the store, not left as an empty entry");
  });

  it("an absent field leaves that override alone", async () => {
    await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });
    // Saving only the start must not silently discard the end the operator set.
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, startedAt: "2026-09-17T20:16:00.000Z" });
    const answered = out.json as ServiceTimeline;
    assert.equal(answered.items[0].startedAt, "2026-09-17T20:16:00.000Z");
    assert.equal(answered.items[0].endedAt, FIXED_END);
    assert.equal(answered.items[0].actualDurationSec, 60);
  });

  it("refuses an end that is not after the start, and saves nothing", async () => {
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: "2026-09-17T20:14:00.000Z" });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
    assert.match(out.body, /end has to come after the start/);
    assert.equal((await serviceTimelineStore.get(KEY))!.itemTimeEdits, undefined);
  });

  it("refuses a time outside the recording's own window", async () => {
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: "2026-09-17T23:00:00.000Z" });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
    assert.match(out.body, /outside the recording's own window/);
    assert.equal((await serviceTimelineStore.get(KEY))!.itemTimeEdits, undefined);
  });

  it("refuses while the service is recording", async () => {
    goLive();
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });
    assert.equal(out.status, 409, `expected 409, got ${out.status}: ${out.body}`);
    assert.match(out.body, /recording right now/);
    assert.equal((await serviceTimelineStore.get(KEY))!.itemTimeEdits, undefined);
  });

  it("refuses a run the recording does not have", async () => {
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 9, endedAt: FIXED_END });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
    assert.match(out.body, /no longer in this recording/);
  });

  it("refuses a body missing the run's sequence", async () => {
    const out = await post({ serviceKey: KEY, itemId: "vid-1", endedAt: FIXED_END });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
    assert.match(out.body, /sequence/);
  });

  it("survives Rebuild from raw — the run is re-derived and the correction goes back on top", async () => {
    // THE case this whole design exists for. events.csv says 11:22 and always
    // will, so a correction written into the item would be thrown away here
    // without a word. Driven through BOTH real routes against a real archive
    // file, not through applyItemTimeEdits: the pure function cannot see a
    // rebuild route that writes the rebuilt record and drops the overlay with it.
    const dir = serviceDirPath(KEY, "2026-09-17");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "events.csv"),
      "at,source,kind,detail,itemId,plannedLengthSec,preService\n" +
        `${WINDOW_START},pco,item,VIDEO: Pre-roll,vid-1,120,false\n` +
        `${PREROLL_END},pco,item,Welcome,wel-1,300,false\n`,
      "utf8",
    );

    await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });

    const rebuilt = await callRoute(historyRoutes, "/api/history/rebuild", { method: "POST", body: { serviceKey: KEY } });
    assert.equal(rebuilt.status, 200, `rebuild failed: ${rebuilt.status} ${rebuilt.body}`);
    assert.equal((rebuilt.json as { timeline: { rebuilt: boolean } }).timeline.rebuilt, true, "precondition: it rebuilt");

    const stored = (await serviceTimelineStore.get(KEY))!;
    assert.equal(stored.items[0].endedAt, PREROLL_END, "the rebuild itself must re-derive the RAW row");
    assert.equal(stored.itemTimeEdits?.length, 1, "the rebuild must carry the overlay");

    const out = await callRoute(historyRoutes, `/api/service-timeline/${encodeURIComponent(KEY)}`);
    const read = out.json as ServiceTimeline;
    assert.equal(read.items[0].endedAt, FIXED_END, "a rebuild must not undo the operator's correction");
    assert.equal(read.items[0].actualDurationSec, 120);
  });

  it("a second save REPLACES the run's correction rather than stacking one", async () => {
    await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: FIXED_END });
    await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: "2026-09-17T20:18:00.000Z" });

    const stored = (await serviceTimelineStore.get(KEY))!;
    assert.equal(stored.itemTimeEdits?.length, 1, "the run must hold ONE correction, not a stack of them");
    assert.equal(stored.itemTimeEdits?.[0].endedAt, "2026-09-17T20:18:00.000Z");

    const out = await callRoute(historyRoutes, `/api/service-timeline/${encodeURIComponent(KEY)}`);
    const read = out.json as ServiceTimeline;
    assert.equal(read.items[0].actualDurationSec, 180);
    assert.deepEqual(
      read.items[0].editedFrom,
      { startedAt: WINDOW_START, endedAt: PREROLL_END, actualDurationSec: 682 },
      "Reset must restore the RECORDING, not the previous correction",
    );
  });

  it("refuses a non-string, non-null time rather than storing it", async () => {
    const out = await post({ serviceKey: KEY, itemId: "vid-1", sequence: 0, endedAt: 1758140000000 });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
    assert.equal((await serviceTimelineStore.get(KEY))!.itemTimeEdits, undefined);
  });
});
