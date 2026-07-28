// Engine tests: the dispatch rules that sit around the pure registries.
//
// Everything here runs through synthetic broadcasts and a recording fake action —
// no sockets, no devices.

import assert from "node:assert/strict";
import { test, describe, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-automation-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");
const { AUTOMATION_TRIGGERS } = await import("./automation-triggers.js");

// A trigger that fires on ANY snapshot, ignoring prev entirely. The real triggers
// all carry their own `prev === null` guard, which means they mask whether the
// ENGINE is also seeding correctly. This one strips that cover so the engine's
// guard is tested on its own — it is the last line of defence if a trigger's guard
// is ever refactored away.
AUTOMATION_TRIGGERS["test.always"] = {
  id: "test.always",
  label: "Always (test only)",
  channel: "pco:live",
  params: [],
  didFire: () => true,
};

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const NOW = Date.parse("2026-07-26T10:00:00Z");
const live = (mode: string) => ({ mode, currentItemTitle: null, serviceTimeId: "st1" });

async function ruleFiringOnServiceStart(over: Record<string, unknown> = {}) {
  const rules = await automationEngine.listRules();
  for (const r of rules) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  const r = await automationEngine.addRule({
    name: "test rule",
    enabled: true,
    trigger: { id: "pco.service-started", params: {} },
    conditions: [],
    action: { id: "log.message", params: { message: "fired" } },
    cooldownSec: 0,
    oncePerService: false,
    ...over,
  });
  return r.id;
}

/** How many log entries record an actual fire (not a suppression)? */
const fires = () => automationLog.list().filter((e) => e.outcome === "fired" || e.outcome === "simulated").length;

describe("dispatch", () => {
  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  test("a rule fires on its trigger's edge", async () => {
    await ruleFiringOnServiceStart();
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW); // seeds
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 1);
  });

  test("THE RESTART GUARD: the first snapshot after start never fires", async () => {
    await ruleFiringOnServiceStart();
    // Engine restarts mid-service: the very first thing it sees is mode "item".
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW);
    assert.equal(fires(), 0, "seeding must never fire — this is the worst failure mode");
  });

  test("an identical repeated snapshot never fires twice", async () => {
    await ruleFiringOnServiceStart();
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 3000);
    assert.equal(fires(), 1);
  });

  test("a disabled rule never fires", async () => {
    await ruleFiringOnServiceStart({ enabled: false });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 0);
  });

  test("panic disarms every rule", async () => {
    await ruleFiringOnServiceStart();
    await automationEngine.setSettings({ disarmed: true });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 0);
  });
});

describe("suppression", () => {
  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  test("cooldown blocks a second fire and is logged with a reason", async () => {
    await ruleFiringOnServiceStart({ cooldownSec: 60 });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 3000);

    assert.equal(fires(), 1, "the second edge is inside the cooldown");
    const suppressed = automationLog.list().filter((e) => e.outcome === "suppressed");
    assert.equal(suppressed.length, 1);
    assert.match(suppressed[0].detail, /cooldown/i, "the reason must be visible, not silent");
  });

  test("cooldown permits a fire once it has elapsed", async () => {
    await ruleFiringOnServiceStart({ cooldownSec: 10 });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 60_000);
    assert.equal(fires(), 2);
  });

  test("oncePerService fires once across repeated edges in one service", async () => {
    await ruleFiringOnServiceStart({ oncePerService: true, cooldownSec: 0 });
    for (const t of [0, 1000, 2000, 3000]) {
      await automationEngine.__handleBroadcast("pco:live", { ...live("preservice"), serviceTimeId: "st1" }, NOW + t);
      await automationEngine.__handleBroadcast("pco:live", { ...live("item"), serviceTimeId: "st1" }, NOW + t + 500);
    }
    assert.equal(fires(), 1);
  });

  test("oncePerService fires again for a different service", async () => {
    await ruleFiringOnServiceStart({ oncePerService: true, cooldownSec: 0 });
    await automationEngine.__handleBroadcast("pco:live", { ...live("preservice"), serviceTimeId: "st1" }, NOW);
    await automationEngine.__handleBroadcast("pco:live", { ...live("item"), serviceTimeId: "st1" }, NOW + 1000);
    await automationEngine.__handleBroadcast("pco:live", { ...live("preservice"), serviceTimeId: "st2" }, NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", { ...live("item"), serviceTimeId: "st2" }, NOW + 3000);
    assert.equal(fires(), 2);
  });

  test("a failed condition is logged rather than silently dropped", async () => {
    await ruleFiringOnServiceStart({
      conditions: [{ id: "service.type-is", params: { serviceTypeId: "nope" } }],
    });
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 0);
    assert.ok(automationLog.list().some((e) => e.outcome === "condition-not-met"));
  });
});

describe("the engine seeds independently of the triggers", () => {
  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  test("the first snapshot on a channel never fires, even for a trigger with no guard of its own", async () => {
    await ruleFiringOnServiceStart({ trigger: { id: "test.always", params: {} } });
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW);
    assert.equal(fires(), 0, "the engine must seed without evaluating — not rely on triggers to refuse");
  });

  test("but it does fire on the SECOND snapshot", async () => {
    await ruleFiringOnServiceStart({ trigger: { id: "test.always", params: {} } });
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(fires(), 1, "seeding must not disable the channel permanently");
  });
});

describe("simulate and test-fire", () => {
  beforeEach(async () => {
    await automationEngine.init();
  });

  test("simulate records the action as simulated, never as fired", async () => {
    await automationEngine.setSettings({ simulate: true, disarmed: false });
    await ruleFiringOnServiceStart();
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(automationLog.list()[0].outcome, "simulated");
  });

  test("test fire runs the action ignoring the trigger, and respects disabled", async () => {
    await automationEngine.setSettings({ simulate: true, disarmed: false });
    const id = await ruleFiringOnServiceStart({ enabled: false });
    const r = await automationEngine.testFire(id);
    assert.equal(r.ok, true, "test fire is explicit operator intent — it runs even when disabled");
    assert.equal(fires(), 1);
  });
});
