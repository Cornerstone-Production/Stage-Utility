// Which board the screens show, and which board a save lands on.
//
// Driven through the REAL controller against a real temp data dir, with the plan
// and service type poked onto its state — what is under test is the controller's
// own resolution and write targeting, not PCO, and stubbing the store would test
// the stub.
//
// The plan-change reload is the case that matters. A board can be saved against
// ONE plan, so the rows every screen shows are plan-dependent: without a reload
// when the plan advances (and the service type does not), next week's wall shows
// the swap somebody made for last week.
//
// Not covered here: the daily prune's PCO lookup. It needs a Planning Center
// account to date a plan, and pruneSlotOverrides' policy — dating from the
// override's own recorded sortDate, and pruning NOTHING for a service type PCO
// could not answer for — is exercised below with sortDate present, which is what
// every override this build writes carries.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slot-targets-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { slotsStore } = await import("./slots-store.js");

const VIEW = "v-slots";
const SRC = "v-source";
const TYPE = "st-main";
const OTHER_TYPE = "st-youth";
const PLAN_A = "plan-a";
const PLAN_B = "plan-b";

type Mutable = {
  state: Record<string, unknown>;
  broadcast: () => void;
  currentPlanSortDate: string | null;
  loadAllViewRawSlots: (serviceTypeId: string | null, planId: string | null) => Promise<void>;
  applyPlan: (plan: { id: string; title: string; seriesTitle: string | null; sortDate: string | null; dates: string | null }) => Promise<void>;
  fetchTeamMembers: (serviceTypeId: string, planId: string) => Promise<void>;
  rawSlotsByView: Map<string, Slot[]>;
};
const ctl = stageController as unknown as Mutable;

function slot(id: string, channel: string): Slot {
  return {
    id,
    channel,
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

const logs: string[] = [];
let realLog: typeof console.log;

before(() => {
  ctl.broadcast = () => {};
  // Neither of these may reach a socket in a unit test. applyPlan pulls the
  // roster, which without credentials would still build and send a PCO request.
  ctl.fetchTeamMembers = async () => {};
  realLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
});

after(() => {
  console.log = realLog;
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

/** A controller with one slots view, a service type and PLAN_A current. */
async function seed(): Promise<void> {
  logs.length = 0;
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    serviceTypeName: "Sunday Morning",
    planId: PLAN_A,
    planDates: "September 13, 2026",
    views: [
      { id: VIEW, name: "Mic Slots", kind: "slots", ndiSource: null, createdAt: "", surface: "display" },
      { id: SRC, name: "Other Wall", kind: "slots", ndiSource: null, createdAt: "", surface: "display" },
    ],
    outputs: [{ id: "out-1", name: "Stage Left", viewId: VIEW }],
  };
  ctl.currentPlanSortDate = "2026-09-13T14:00:00Z";
  // Reset through the real store rather than by rewriting the file: the store
  // caches the parsed file, so bytes written behind it would be invisible and
  // every test after the first would assert against the previous one's leftovers.
  for (const key of [VIEW, SRC]) {
    await slotsStore.setDefault(key, TYPE, []);
    await slotsStore.setDefault(key, OTHER_TYPE, []);
    for (const planId of Object.keys((await slotsStore.allOverrides())[key] ?? {})) {
      await slotsStore.clearOverride(key, planId);
    }
  }
  await ctl.loadAllViewRawSlots(TYPE, PLAN_A);
}

beforeEach(seed);

describe("saving a board", () => {
  it("with no target, while a plan is current, writes THAT PLAN's override", async () => {
    await stageController.setViewSlots(VIEW, [slot("s1", "07")]);

    const override = await slotsStore.getOverride(VIEW, PLAN_A);
    assert.equal(
      override?.slots[0]?.id,
      "s1",
      "a plain save changes what the operator is looking at, which is this week's board",
    );
    assert.deepEqual(
      await slotsStore.getDefault(VIEW, TYPE),
      [],
      "and it must NOT touch the service type's default — that is the bug this model exists to fix",
    );
  });

  it("records the plan's date on the override, so it can be pruned later", async () => {
    await stageController.setViewSlots(VIEW, [slot("s1", "07")]);
    assert.equal((await slotsStore.getOverride(VIEW, PLAN_A))?.sortDate, "2026-09-13T14:00:00Z");
  });

  it('with {kind:"default"} writes the DEFAULT and leaves the override alone', async () => {
    await stageController.setViewSlots(VIEW, [slot("week", "01")]);
    await stageController.setViewSlots(VIEW, [slot("standing", "02")], { kind: "default", serviceTypeId: TYPE });

    assert.equal((await slotsStore.getDefault(VIEW, TYPE))[0]?.id, "standing");
    assert.equal((await slotsStore.getOverride(VIEW, PLAN_A))?.slots[0]?.id, "week");
  });

  it("saving the default does not change what the screens show while an override is in effect", async () => {
    await stageController.setViewSlots(VIEW, [slot("week", "01")]);
    await stageController.setViewSlots(VIEW, [slot("standing", "02")], { kind: "default", serviceTypeId: TYPE });

    assert.equal(
      ctl.rawSlotsByView.get(VIEW)?.[0]?.id,
      "week",
      "editing the type's default is not a live change — the plan's own board still wins",
    );
  });

  it("with no plan current, writes the type's default", async () => {
    ctl.state = { ...ctl.state, planId: null };
    await ctl.loadAllViewRawSlots(TYPE, null);

    await stageController.setViewSlots(VIEW, [slot("s1", "07")]);
    assert.equal((await slotsStore.getDefault(VIEW, TYPE))[0]?.id, "s1");
  });

  it("names the target on the log line", async () => {
    await stageController.setViewSlots(VIEW, [slot("s1", "07")]);
    await stageController.setViewSlots(VIEW, [slot("s2", "08")], { kind: "default", serviceTypeId: TYPE });

    const lines = logs.filter((l) => l.includes("setViewSlots ("));
    assert.equal(lines.length, 2);
    assert.match(
      lines[0],
      /target=plan:plan-a/,
      "an operator reading /log has to be able to tell which of the two boards a save changed",
    );
    assert.match(lines[1], /target=default:st-main/);
  });
});

describe("changing plan within a service type", () => {
  it("reloads the rows to the new plan's override", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing", "01")]);
    await slotsStore.setOverride(VIEW, PLAN_B, TYPE, [slot("next-week", "02")], "2026-09-20T14:00:00Z");

    await ctl.applyPlan({ id: PLAN_B, title: "Sep 20", seriesTitle: null, sortDate: "2026-09-20T14:00:00Z", dates: "September 20, 2026" });

    assert.equal(
      ctl.rawSlotsByView.get(VIEW)?.[0]?.id,
      "next-week",
      "the override is keyed by PLAN, so advancing the plan has to re-read the rows even though the service type did not change",
    );
  });

  it("shows the default again for a plan with no override", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing", "01")]);
    await slotsStore.setOverride(VIEW, PLAN_A, TYPE, [slot("this-week", "02")], "2026-09-13T14:00:00Z");
    await ctl.loadAllViewRawSlots(TYPE, PLAN_A);
    assert.equal(ctl.rawSlotsByView.get(VIEW)?.[0]?.id, "this-week");

    await ctl.applyPlan({ id: PLAN_B, title: "Sep 20", seriesTitle: null, sortDate: "2026-09-20T14:00:00Z", dates: "September 20, 2026" });

    assert.equal(
      ctl.rawSlotsByView.get(VIEW)?.[0]?.id,
      "standing",
      "a swap made for one week must not become every following week's board",
    );
  });
});

describe("revert to default and set as default", () => {
  it("revert drops the override and puts the default back on screen", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing", "01")]);
    await stageController.setViewSlots(VIEW, [slot("week", "02")]);
    assert.equal(ctl.rawSlotsByView.get(VIEW)?.[0]?.id, "week");

    await stageController.clearSlotsOverride("view", VIEW, PLAN_A);

    assert.equal(await slotsStore.getOverride(VIEW, PLAN_A), null);
    assert.equal(ctl.rawSlotsByView.get(VIEW)?.[0]?.id, "standing");
  });

  it("revert refuses when there is nothing to revert", async () => {
    await assert.rejects(
      () => stageController.clearSlotsOverride("view", VIEW, PLAN_A),
      /nothing to revert/,
      "a revert that changed nothing must not report success",
    );
  });

  it("promote makes this week's board the type's default", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing", "01")]);
    await stageController.setViewSlots(VIEW, [slot("week", "02")]);

    await stageController.promoteSlotsOverride("view", VIEW, PLAN_A);

    assert.equal((await slotsStore.getDefault(VIEW, TYPE))[0]?.id, "week");
    assert.equal(await slotsStore.getOverride(VIEW, PLAN_A), null);
    assert.equal(ctl.rawSlotsByView.get(VIEW)?.[0]?.id, "week", "and the screens do not flicker back");
  });

  it("promote refuses when there is nothing to promote", async () => {
    await assert.rejects(
      () => stageController.promoteSlotsOverride("view", VIEW, PLAN_A),
      /nothing to promote/,
    );
  });
});

describe("the editor's two boards", () => {
  it("reports the default, and the override only when the current plan has one", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing", "01")]);

    let targets = await stageController.getSlotTargets("view", VIEW);
    assert.equal(targets.defaultSlots[0]?.id, "standing");
    assert.equal(targets.overrideSlots, null, "no override means the plan side is not badged as edited");
    assert.equal(targets.planId, PLAN_A);
    assert.equal(targets.serviceTypeName, "Sunday Morning");

    await stageController.setViewSlots(VIEW, [slot("week", "02")]);
    targets = await stageController.getSlotTargets("view", VIEW);
    assert.equal(targets.overrideSlots?.[0]?.id, "week");
    assert.equal(targets.defaultSlots[0]?.id, "standing", "and the default is still readable behind it");
  });

  it("does not offer an override belonging to another service type", async () => {
    await slotsStore.setOverride(VIEW, PLAN_A, OTHER_TYPE, [slot("wrong", "09")], null);
    const targets = await stageController.getSlotTargets("view", VIEW);
    assert.equal(
      targets.overrideSlots,
      null,
      "offering it would let Revert to default discard a board the operator cannot see",
    );
  });
});

describe("pruning", () => {
  it("drops an override whose plan is long past and keeps a current one", async () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing", "01")]);
    await slotsStore.setOverride(VIEW, "plan-ancient", TYPE, [slot("a", "01")], old);
    await slotsStore.setOverride(VIEW, "plan-recent", TYPE, [slot("b", "02")], recent);

    const pruned = await stageController.pruneSlotOverrides();

    assert.equal(pruned, 1);
    assert.equal(await slotsStore.getOverride(VIEW, "plan-ancient"), null);
    assert.ok(await slotsStore.getOverride(VIEW, "plan-recent"), "two days ago is not 30 days ago");
    assert.equal(
      (await slotsStore.getDefault(VIEW, TYPE))[0]?.id,
      "standing",
      "and the operator's standing board is never what gets tidied away",
    );
    assert.ok(
      logs.some((l) => /\[slots\] pruned 1 override\(s\) for plans older than 30 days/.test(l)),
      "a deletion an operator did not ask for says so on a tagged line",
    );
  });

  it("says nothing when there was nothing to prune", async () => {
    await slotsStore.setOverride(VIEW, PLAN_A, TYPE, [slot("a", "01")], new Date().toISOString());
    assert.equal(await stageController.pruneSlotOverrides(), 0);
    assert.equal(logs.filter((l) => l.includes("[slots] pruned")).length, 0);
  });
});

// "Copy slots from another view" writes ONE board and deletes nothing.
//
// It used to write the source's DEFAULT into the destination's default whichever
// side the editor was on, and then clearOverride() the destination's board for
// the current plan — an unconfirmed, unlogged deletion of an operator's week,
// sitting next to a Revert action that confirms and logs the same deletion. Both
// halves are asserted here: the board that was NOT targeted is untouched, and
// nothing that existed before the copy is gone after it.
describe("copying slots from another view", () => {
  beforeEach(async () => {
    await slotsStore.setDefault(SRC, TYPE, [slot("src-standing", "01")]);
    await slotsStore.setDefault(VIEW, TYPE, [slot("dst-standing", "02")]);
  });

  it("on the default side writes the destination's DEFAULT and leaves its override alone", async () => {
    await slotsStore.setOverride(VIEW, PLAN_A, TYPE, [slot("dst-week", "03")], null);
    await slotsStore.setOverride(SRC, PLAN_A, TYPE, [slot("src-week", "04")], null);

    await stageController.copyViewSlots(VIEW, SRC, { kind: "default", serviceTypeId: TYPE });

    assert.equal(
      (await slotsStore.getDefault(VIEW, TYPE))[0]?.channel,
      "01",
      "the source's default is what the Default side copies",
    );
    assert.equal(
      (await slotsStore.getOverride(VIEW, PLAN_A))?.slots[0]?.channel,
      "03",
      "the destination's board for this week is not part of a copy onto the Default side, and deleting it was unconfirmed and unlogged",
    );
  });

  it("on the plan side writes the destination's OVERRIDE and leaves its default alone", async () => {
    await slotsStore.setOverride(SRC, PLAN_A, TYPE, [slot("src-week", "04")], null);

    await stageController.copyViewSlots(VIEW, SRC, {
      kind: "plan",
      planId: PLAN_A,
      serviceTypeId: TYPE,
    });

    assert.equal((await slotsStore.getOverride(VIEW, PLAN_A))?.slots[0]?.channel, "04");
    assert.equal(
      (await slotsStore.getDefault(VIEW, TYPE))[0]?.channel,
      "02",
      "a copy made while looking at this week must not rewrite the service type's standing board",
    );
  });

  it("on the plan side with no source override copies the source's DEFAULT into the override", async () => {
    await stageController.copyViewSlots(VIEW, SRC, {
      kind: "plan",
      planId: PLAN_A,
      serviceTypeId: TYPE,
    });

    assert.equal(
      (await slotsStore.getOverride(VIEW, PLAN_A))?.slots[0]?.channel,
      "01",
      "the point of the action is that this view now shows what the other one shows",
    );
    assert.equal((await slotsStore.getDefault(VIEW, TYPE))[0]?.channel, "02");
    assert.equal(
      ctl.rawSlotsByView.get(VIEW)?.[0]?.channel,
      "01",
      "and the screens follow it, because the override is what is in effect",
    );
  });

  it("mints fresh slot ids, so the two views are not the same rows", async () => {
    await stageController.copyViewSlots(VIEW, SRC, { kind: "default", serviceTypeId: TYPE });
    const copied = (await slotsStore.getDefault(VIEW, TYPE))[0]?.id;
    assert.equal((await slotsStore.getDefault(SRC, TYPE))[0]?.id, "src-standing");
    assert.notEqual(copied, "src-standing", "editing one view's row would otherwise edit the other's");
  });

  it("names the target on the log line, like every other slot write", async () => {
    await stageController.copyViewSlots(VIEW, SRC, { kind: "default", serviceTypeId: TYPE });
    assert.ok(
      logs.some((l) => /setViewSlots \(1 slots\) for view=v-slots target=default:st-main/.test(l)),
      "a copy is a write, and an operator reading /log has to see which board it changed",
    );
  });

  it("404s for a source view that does not exist", async () => {
    await assert.rejects(
      () => stageController.copyViewSlots(VIEW, "v-nope", { kind: "default", serviceTypeId: TYPE }),
      (err: Error) => err.name === "SlotsNotFoundError" && /v-nope/.test(err.message),
    );
  });
});

describe("a request naming something that is not there", () => {
  it("refuses a save to an unknown view rather than writing a board nothing reads", async () => {
    await assert.rejects(
      () => stageController.setViewSlots("v-typo", [slot("s1", "07")]),
      (err: Error) => err.name === "SlotsNotFoundError",
    );
  });

  it("refuses to report both boards for an unknown view", async () => {
    await assert.rejects(
      () => stageController.getSlotTargets("view", "v-typo"),
      (err: Error) => err.name === "SlotsNotFoundError",
    );
  });

  it("refuses an inline object id that is on no layout", async () => {
    await assert.rejects(
      () => stageController.setLayoutObjectSlots("obj-nowhere", [slot("s1", "07")]),
      (err: Error) => err.name === "SlotsNotFoundError" && /no inline mic-slots object/.test(err.message),
    );
  });
});

describe("a plan target naming the wrong service type", () => {
  it("is refused as a 400, not saved somewhere nothing can read it", async () => {
    await assert.rejects(
      () =>
        stageController.setViewSlots(VIEW, [slot("s1", "07")], {
          kind: "plan",
          planId: PLAN_A,
          serviceTypeId: OTHER_TYPE,
        }),
      (err: Error & { status?: number }) =>
        err.name === "SlotsNotFoundError" && err.status === 400 && /belongs to service type/.test(err.message),
      "an override is only ever honoured for the type it was saved against, so this board would be invisible AND unprunable",
    );
    assert.equal(await slotsStore.getOverride(VIEW, PLAN_A), null, "and nothing was written");
  });

  it("is allowed for the current plan's own type", async () => {
    await stageController.setViewSlots(VIEW, [slot("s1", "07")], {
      kind: "plan",
      planId: PLAN_A,
      serviceTypeId: TYPE,
    });
    assert.equal((await slotsStore.getOverride(VIEW, PLAN_A))?.slots[0]?.id, "s1");
  });

  // A plan that is NOT the current one has to be looked up in Planning Center,
  // and there are no credentials here. listPlans throws, the controller logs the
  // reason and ACCEPTS — an unreachable integration is not evidence that a plan
  // belongs to another service type. That branch is what runs below.
  it("is allowed when Planning Center cannot say, and says so on a tagged line", async () => {
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.map((a) => String(a)).join(" "));
    try {
      await stageController.setViewSlots(VIEW, [slot("s1", "07")], {
        kind: "plan",
        planId: "plan-elsewhere",
        serviceTypeId: TYPE,
      });
    } finally {
      console.warn = realWarn;
    }
    assert.equal((await slotsStore.getOverride(VIEW, "plan-elsewhere"))?.slots[0]?.id, "s1");
    assert.ok(
      warns.some((l) => l.includes("[slots] could not check which service type a plan belongs to")),
      "a check that silently did not run is one nobody can debug at 9am on a Sunday",
    );
  });
});

describe("the prune timers", () => {
  it("stopSlotsPruning cancels the boot sweep too", () => {
    const c = ctl as unknown as {
      startSlotsPruning: () => void;
      slotsPruneBootTimer: unknown;
      slotsPruneTimer: unknown;
    };
    c.startSlotsPruning();
    assert.ok(c.slotsPruneBootTimer, "the one-shot sweep ten seconds after boot");
    stageController.stopSlotsPruning();
    assert.equal(
      c.slotsPruneBootTimer,
      null,
      "the boot handle was not stored, so a restore that paused background work still had a prune fire into the file it was restoring",
    );
    assert.equal(c.slotsPruneTimer, null);
  });
});
