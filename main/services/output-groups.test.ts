// Which message groups a screen belongs to has to survive a restart and reach the
// kiosk, the same two ways allowHls does (output-allow-hls.test.ts):
//
//  1. set on the in-memory Output but never written, so a restart forgets that
//     the stage wall is in the Stage group and a message to it reaches no one;
//  2. stored fine but never copied onto ResolvedOutput, the descriptor the
//     kiosk reads.
//
// Plus what is new here: the ids are checked against the messaging config, a
// deleted group comes off every screen in ONE write, and a screen never takes
// another screen's groups. These drive the REAL controller against a real data
// directory, so both ends are read back: what landed in settings.json, and what
// a kiosk would be handed.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-output-groups-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { settingsStore } = await import("./settings-store.js");
const { messagingStore } = await import("./messaging-store.js");

type Mutable = {
  state: { views: View[]; outputs: Output[]; [k: string]: unknown };
  broadcast: () => void;
};

const ctl = stageController as unknown as Mutable;
let broadcasts = 0;
ctl.broadcast = () => {
  broadcasts++;
};

const recompute = () =>
  (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();

let green = "";
let stage = "";
let booth = "";

beforeEach(async () => {
  // Three groups, in the order the config holds them. The ids are issued by the
  // store, so they are read back rather than invented.
  const { config } = await messagingStore.replace({
    groups: [{ name: "Green room" }, { name: "Stage" }, { name: "Booth" }],
    quickMessages: [],
    quickReplies: [],
  });
  [green, stage, booth] = config.groups.map((g) => g.id);
  ctl.state = {
    ...ctl.state,
    views: [{ id: "v1", name: "Mic board", kind: "slots", createdAt: "" }] as View[],
    outputs: [
      { id: "wall", name: "Stage wall", viewId: "v1" },
      { id: "lobby", name: "Lobby", viewId: "v1" },
      { id: "foh", name: "FOH", viewId: "v1" },
    ] as Output[],
  };
  recompute();
  broadcasts = 0;
});

/** The outputs as they are actually on disk, read back rather than trusted. */
async function storedOutputs(): Promise<Output[]> {
  const raw = await fs.readFile(path.join(TMP, "settings.json"), "utf8");
  return (JSON.parse(raw) as { outputs?: Output[] }).outputs ?? [];
}

const resolvedFor = (id: string) => (stageController.getState().resolvedByOutput ?? {})[id];

describe("putting a screen in message groups", () => {
  it("defaults to none, and reaches the descriptor the kiosk reads", async () => {
    assert.deepEqual(resolvedFor("wall")?.groups, [], "a screen with no groups must resolve to []");
    await stageController.setOutputGroups("wall", [stage]);
    assert.deepEqual(
      resolvedFor("wall")?.groups,
      [stage],
      "the groups never reached ResolvedOutput — the kiosk would not know which messages are for it",
    );
  });

  it("survives a restart, because it is on disk and not just in memory", async () => {
    await stageController.setOutputGroups("wall", [green, stage]);
    const stored = await storedOutputs();
    assert.deepEqual(stored.find((o) => o.id === "wall")?.groups, [green, stage], "the groups were not persisted");

    // A restart is the stored outputs read back into a controller that knows
    // nothing; recomputing from them is what the boot path does.
    ctl.state = { ...ctl.state, outputs: stored };
    recompute();
    assert.deepEqual(resolvedFor("wall")?.groups, [green, stage], "the stored groups did not come back");
  });

  it("is per screen: giving one a group leaves the others with none", async () => {
    await stageController.setOutputGroups("wall", [stage]);
    assert.deepEqual(resolvedFor("lobby")?.groups, [], "one screen's group bled onto another");
    assert.deepEqual(resolvedFor("foh")?.groups, []);
    const stored = await storedOutputs();
    assert.equal(stored.find((o) => o.id === "lobby")?.groups, undefined);
  });

  it("refuses a group that does not exist, naming it, and writes nothing", async () => {
    await stageController.setOutputGroups("wall", [green]);
    const before = JSON.stringify(await storedOutputs());
    await assert.rejects(
      () => stageController.setOutputGroups("wall", [green, "g-00000000"]),
      /no message group has the id g-00000000/,
    );
    assert.equal(JSON.stringify(await storedOutputs()), before, "a refused request changed what is stored");
    assert.deepEqual(resolvedFor("wall")?.groups, [green]);
  });

  it("refuses anything that is not a list of group ids", async () => {
    for (const bad of ["g-00000000", { 0: green }, [5], null, undefined]) {
      await assert.rejects(
        () => stageController.setOutputGroups("wall", bad),
        /groups must be an array of group ids/,
        `accepted ${JSON.stringify(bad)}`,
      );
    }
  });

  it("deduplicates, and keeps the config's order rather than the order it was asked in", async () => {
    await stageController.setOutputGroups("wall", [booth, green, booth, green]);
    assert.deepEqual(
      resolvedFor("wall")?.groups,
      [green, booth],
      "expected the config's order (Green room, Stage, Booth) with each id once",
    );
  });

  it("takes an empty list as leaving every group", async () => {
    await stageController.setOutputGroups("wall", [green]);
    await stageController.setOutputGroups("wall", []);
    assert.deepEqual(resolvedFor("wall")?.groups, []);
  });

  it("refuses an output that does not exist rather than writing a ghost, whatever else is wrong", async () => {
    await assert.rejects(() => stageController.setOutputGroups("display-nowhere", [green]), /not found/i);
    await assert.rejects(() => stageController.setOutputGroups("display-nowhere", ["g-00000000"]), /not found/i);
    await assert.rejects(() => stageController.setOutputGroups("display-nowhere", "x"), /not found/i);
  });
});

describe("taking deleted groups off every screen", () => {
  /** Counts what reaches settings.json, so "one write" is read rather than assumed. */
  function countPatches(): { count: () => number; restore: () => void } {
    const real = settingsStore.patch.bind(settingsStore);
    let n = 0;
    settingsStore.patch = ((...args: Parameters<typeof real>) => {
      n++;
      return real(...args);
    }) as typeof settingsStore.patch;
    return { count: () => n, restore: () => void (settingsStore.patch = real) };
  }

  async function seedGroups() {
    await stageController.setOutputGroups("wall", [green, stage]);
    await stageController.setOutputGroups("lobby", [stage, booth]);
    await stageController.setOutputGroups("foh", [booth]);
    broadcasts = 0;
  }

  it("removes them from every screen that had them in ONE settings write, and says how many changed", async () => {
    await seedGroups();
    const spy = countPatches();
    try {
      const changed = await stageController.stripOutputGroups([stage, green]);
      assert.equal(changed, 2, "wall and lobby had a deleted group; foh did not");
      assert.equal(spy.count(), 1, "one settings write per screen is the loop this exists to avoid");
    } finally {
      spy.restore();
    }
    assert.deepEqual(resolvedFor("wall")?.groups, []);
    assert.deepEqual(resolvedFor("lobby")?.groups, [booth], "a group that was NOT deleted must stay");
    assert.deepEqual(resolvedFor("foh")?.groups, [booth]);
    const stored = await storedOutputs();
    assert.deepEqual(stored.find((o) => o.id === "wall")?.groups, []);
    assert.deepEqual(stored.find((o) => o.id === "lobby")?.groups, [booth]);
    assert.equal(broadcasts, 1, "every connected client is told once, not once per screen");
  });

  it("writes and broadcasts nothing when no screen had one of them", async () => {
    await seedGroups();
    const spy = countPatches();
    try {
      assert.equal(await stageController.stripOutputGroups(["g-00000000"]), 0);
      assert.equal(await stageController.stripOutputGroups([]), 0);
      assert.equal(spy.count(), 0, "a deletion that touched no screen still rewrote settings.json");
    } finally {
      spy.restore();
    }
    assert.equal(broadcasts, 0);
  });
});
