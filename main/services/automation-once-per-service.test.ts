// Which service a once-per-service cue has already run for.
//
// The engine used to key oncePerService on the live serviceTimeId. That id rolls
// on to the NEXT occurrence once the current one passes its planned end
// (pick-service-time.ts), so a cue that ran in the last stretch of a long 9am was
// filed under the 11am, and at the 11am's own moment it was suppressed as
// "already fired this service". The recorders hold their occurrence across that
// roll-over; the engine now asks the timeline recorder which occurrence a tick
// belongs to, and every case below is driven through the real recorder.
//
// Ticks run in the live-poller's order: the pco:live broadcast reaches the engine
// FIRST, and the recorders see the same snapshot after it (live-poller.ts act()).
// So when the engine judges a tick the recorder has not yet acted on it, and the
// answer has to be the occurrence that tick WILL be recorded against, not the
// record as it stood a tick ago.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-once-per-service-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { stageController } = await import("./stage-controller.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");
import type { PcoLiveDTO } from "../types/stage.js";

type Held = {
  current: unknown;
  currentKey: string | null;
  lastLiveAt: number;
  lastItemId: string | null;
  forget(key: string): boolean;
};
const held = serviceTimelineRecorder as unknown as Held;

// Sunday 23 Aug 2026, Chicago (UTC-5). The 9am is planned to end at 10:15.
const NINE = { id: "occ-9am", startsAt: "2026-08-23T14:00:00.000Z" };
const ELEVEN = { id: "occ-11am", startsAt: "2026-08-23T16:00:00.000Z" };

type Occ = { id: string | null; startsAt: string | null };

function snapshot(at: string, occ: Occ, item: { id: string; title: string } | null): PcoLiveDTO {
  return {
    mode: item ? "item" : "preservice",
    currentItemId: item?.id ?? null,
    label: item?.title ?? null,
    itemType: null,
    lengthSec: 300,
    liveStartAt: item ? at : null,
    targetAt: item ? null : occ.startsAt,
    serverNow: at,
    currentItemTitle: item?.title ?? null,
    nextItemTitle: null,
    serviceTimeId: occ.id,
    serviceTimeStartsAt: occ.startsAt,
    beforeServiceStart: false,
  };
}

/** One poll, in the live-poller's order: the engine hears it, then the recorder. */
async function poll(at: string, occ: Occ, item: { id: string; title: string } | null): Promise<void> {
  mock.timers.setTime(Date.parse(at));
  const live = snapshot(at, occ, item);
  await automationEngine.__handleBroadcast("pco:live", live, Date.parse(at));
  await serviceTimelineRecorder.onLiveTick(live);
}

async function onceRule(trigger: { id: string; params: Record<string, string | number> }): Promise<void> {
  for (const r of await automationEngine.listRules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  await automationEngine.addRule({
    name: "once a service",
    enabled: true,
    trigger,
    conditions: [],
    action: { id: "log.message", params: { message: "ran" } },
    cooldownSec: 0,
    oncePerService: true,
  });
}

const fires = () => automationLog.list().filter((e) => e.outcome === "fired" || e.outcome === "simulated").length;
const suppressed = () =>
  automationLog
    .list()
    .filter((e) => e.outcome === "suppressed")
    .map((e) => e.detail);

let planId = "";
let n = 0;

describe("oncePerService keys on the occurrence the recorders use", () => {
  beforeEach(async () => {
    mock.timers.enable({ apis: ["Date"] });
    planId = `plan-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "type-1",
      serviceTypeName: "Sunday",
      planId,
      planTitle: "A plan",
      planSeriesTitle: null,
    });
    held.current = null;
    held.currentKey = null;
    held.lastLiveAt = 0;
    held.lastItemId = null;
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  afterEach(() => {
    held.forget(held.currentKey ?? "");
    held.current = null;
    held.currentKey = null;
    mock.timers.reset();
  });

  it("a cue run during a 9am overrun still runs at the 11am", async () => {
    await onceRule({ id: "pco.item-reached", params: { title: "Benediction" } });

    await poll("2026-08-23T13:55:00.000Z", NINE, null); // seeds the engine
    await poll("2026-08-23T14:00:00.000Z", NINE, { id: "welcome", title: "Welcome" });
    await poll("2026-08-23T15:00:00.000Z", NINE, { id: "sermon", title: "Sermon" });
    // 10:20: the 9am is past its planned end, so PCO's current service time has
    // rolled to the 11am. The 11am starts in 40 minutes and the recorder holds
    // the 9am's record through it.
    await poll("2026-08-23T15:20:00.000Z", ELEVEN, { id: "sermon", title: "Sermon" });
    await poll("2026-08-23T15:25:00.000Z", ELEVEN, { id: "benediction", title: "Benediction" });
    assert.equal(fires(), 1, "the 9am's benediction runs the cue");

    await poll("2026-08-23T15:30:00.000Z", ELEVEN, null); // the 9am is over
    await poll("2026-08-23T16:00:00.000Z", ELEVEN, { id: "welcome", title: "Welcome" });
    await poll("2026-08-23T17:15:00.000Z", ELEVEN, { id: "benediction", title: "Benediction" });

    assert.deepEqual(suppressed(), [], "the 11am never ran it, so nothing is suppressed");
    assert.equal(fires(), 2, "and the 11am's benediction runs it too");
  });

  it("the 11am's opening item, straight off the 9am's last, is the 11am", async () => {
    // PCO need never leave item mode between two services on one plan (the 18
    // Sep 2026 incident in service-recorder.test.ts). The opening item going live
    // again is what tells the recorder the next service has begun, and it acts
    // on that AFTER the engine has judged the same tick.
    await onceRule({ id: "pco.item-reached", params: { title: "Doors" } });

    await poll("2026-08-23T13:45:00.000Z", NINE, null);
    await poll("2026-08-23T13:50:00.000Z", NINE, { id: "doors", title: "Doors" });
    assert.equal(fires(), 1, "the 9am's doors run the cue");
    await poll("2026-08-23T15:00:00.000Z", NINE, { id: "sermon", title: "Sermon" });
    await poll("2026-08-23T15:35:00.000Z", ELEVEN, { id: "sermon", title: "Sermon" }); // held
    await poll("2026-08-23T15:40:00.000Z", ELEVEN, { id: "doors", title: "Doors" });

    assert.deepEqual(suppressed(), []);
    assert.equal(fires(), 2, "the 11am's doors run it again");
  });

  it("a cue run before the record opens is the same service once it has", async () => {
    // The first item's tick reaches the engine before the recorder has opened a
    // record for it, and a reprise of that item reaches it with the record open.
    // Both have to name the 9am the same way, or the reprise runs the cue again:
    // a full service key on one side and a bare service-time id on the other
    // never match.
    await onceRule({ id: "pco.item-reached", params: { title: "Welcome" } });

    await poll("2026-08-23T13:50:00.000Z", NINE, null);
    await poll("2026-08-23T14:00:00.000Z", NINE, { id: "welcome", title: "Welcome" });
    assert.equal(fires(), 1);
    await poll("2026-08-23T14:05:00.000Z", NINE, { id: "song", title: "Song" });
    await poll("2026-08-23T14:10:00.000Z", NINE, { id: "welcome", title: "Welcome" }); // reprised, record open

    assert.equal(fires(), 1, "still the 9am: the cue does not run twice");
    assert.deepEqual(suppressed(), ["already fired this service"]);
  });

  it("a plan with no service time is not taken for the last one that had one", async () => {
    // The live id was remembered only when it was non-empty, so a plan PCO gave
    // no service time to inherited the previous service's id, and a cue that ran
    // on Sunday was suppressed on Wednesday.
    await onceRule({ id: "pco.service-started", params: {} });

    await poll("2026-08-23T13:50:00.000Z", NINE, null);
    await poll("2026-08-23T14:00:00.000Z", NINE, { id: "welcome", title: "Welcome" });
    await poll("2026-08-23T16:00:00.000Z", NINE, null);
    assert.equal(fires(), 1);

    const WEDNESDAY = { id: null, startsAt: null };
    await poll("2026-08-26T23:55:00.000Z", WEDNESDAY, null);
    await poll("2026-08-27T00:00:00.000Z", WEDNESDAY, { id: "welcome", title: "Welcome" });

    assert.deepEqual(suppressed(), []);
    assert.equal(fires(), 2, "Wednesday is its own service");
  });
});
