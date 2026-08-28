// "Ticks clear when the next service plan starts" — the requirement, tested
// against real files rather than a mock, because the thing that could go wrong
// is persistence.
//
// The rollover is not a scheduled job that empties anything. Buckets are per
// plan, so a new plan simply reads an empty one. That is what makes it
// impossible for last week's ticks to be shown against this week's list even if
// a clearing job never ran, was late, or crashed halfway.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ticks-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { checklistTicksStore } = await import("./checklist-ticks-store.js");
const { configFiles, runtimeFiles } = await import("./config-snapshot.js");

const FILE = path.join(TMP, "checklist-ticks.json");

describe("checklist ticks are an observation, not the operator's work", () => {
  it("is classified runtime, so a restore does not resurrect old ticks", async () => {
    await checklistTicksStore.init();
    assert.ok(
      runtimeFiles().includes("checklist-ticks.json"),
      "ticks must be runtime: restoring a six-month-old backup would tick this Sunday's list",
    );
    assert.ok(!configFiles().includes("checklist-ticks.json"));
  });
});

/** What is actually on disk, which is the only honest test of persistence. */
async function onDisk(): Promise<Record<string, string[]>> {
  return JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, string[]>;
}

// Every test uses ITS OWN plan ids rather than clearing the file between them.
//
// DataStore.load() returns an in-memory cache once it is warm, so removing the
// file and calling init() does NOT reload from disk — it hands back the same
// Map. A beforeEach written that way leaks one test's ticks into the next, and,
// worse, a "survives a restart" test written that way passes without the data
// ever having reached the disk. Reading the file is the only assertion that
// proves persistence, so that is what the restart test does.
describe("ticks belong to a plan", () => {
  it("remembers a tick", async () => {
    await checklistTicksStore.set("remember-1", "Production batteries", true);
    assert.deepEqual(checklistTicksStore.get("remember-1"), ["Production batteries"]);
  });

  it("is on DISK, not only in memory", async () => {
    await checklistTicksStore.set("disk-1", "Production batteries", true);
    assert.deepEqual(
      (await onDisk())["disk-1"],
      ["Production batteries"],
      "the tick never reached the file, so a restart would lose it",
    );
  });

  it("unticks, on disk too", async () => {
    await checklistTicksStore.set("untick-1", "Production batteries", true);
    await checklistTicksStore.set("untick-1", "Production batteries", false);
    assert.deepEqual(checklistTicksStore.get("untick-1"), []);
    assert.deepEqual((await onDisk())["untick-1"], []);
  });

  it("THE NEXT PLAN STARTS CLEAN", async () => {
    // The requirement, stated as the test that would catch its absence: a single
    // shared bucket passes every test above and fails only this one.
    await checklistTicksStore.set("rollover-1", "Production batteries", true);
    assert.deepEqual(
      checklistTicksStore.get("rollover-2"),
      [],
      "last week's ticks showed up against the next plan",
    );
  });

  it("keeps the previous plan's ticks rather than deleting them", async () => {
    // Selecting the wrong plan and going back must not report that nobody did
    // anything last week.
    await checklistTicksStore.set("keep-1", "Production batteries", true);
    await checklistTicksStore.set("keep-2", "Production CO2", true);
    assert.deepEqual(checklistTicksStore.get("keep-1"), ["Production batteries"]);
  });

  it("clears one plan on request without touching another", async () => {
    await checklistTicksStore.set("clear-1", "a", true);
    await checklistTicksStore.set("clear-2", "b", true);
    await checklistTicksStore.clear("clear-1");
    assert.deepEqual(checklistTicksStore.get("clear-1"), []);
    assert.deepEqual(checklistTicksStore.get("clear-2"), ["b"]);
  });

  it("refuses a plan id that is a prototype key", async () => {
    // The id reaches this store from the wire. A Map makes it harmless, and this
    // keeps a nonsense id from creating an entry nothing will ever read.
    await assert.rejects(() => checklistTicksStore.set("__proto__", "a", true), /unsafe plan id/);
  });
});

// Pruning is measured on the FILE and in isolation, because it is about how many
// plans the store holds in total — a shared file with other tests' plans in it
// would make the count meaningless.
describe("the file does not grow without limit", () => {
  beforeEach(async () => {
    await fs.rm(FILE, { force: true });
  });

  it("keeps only the four most recent plans", async () => {
    for (let i = 1; i <= 8; i++) await checklistTicksStore.set(`prune-${i}`, "a", true);
    const kept = Object.keys(await onDisk()).filter((k) => k.startsWith("prune-"));
    assert.deepEqual(kept, ["prune-5", "prune-6", "prune-7", "prune-8"], "pruned the wrong end");
  });

  it("does not prune the plan being worked on", async () => {
    // Ticking a plan again must move it to the front of the queue. Without that,
    // an install ticking one plan across several weeks of other plans would
    // silently lose the one in use.
    for (let i = 1; i <= 4; i++) await checklistTicksStore.set(`inuse-${i}`, "a", true);
    await checklistTicksStore.set("inuse-1", "b", true); // touched again
    await checklistTicksStore.set("inuse-5", "a", true); // pushes one out
    assert.deepEqual(
      checklistTicksStore.get("inuse-1").sort(),
      ["a", "b"],
      "the plan in use was pruned",
    );
  });
});
