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
const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");

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

// An action with a side effect the tests can count, and one that fails the way a
// baptism action does when the timer is idle. `log.message` cannot show whether
// simulate really stopped the action: it does nothing either way.
const sent: string[] = [];
AUTOMATION_ACTIONS["test.record"] = {
  id: "test.record",
  label: "Record (test only)",
  params: [],
  run: async (_params, ctx) => {
    if (!ctx.simulate) sent.push("sent");
    return { ok: true, detail: ctx.simulate ? "would send" : "sent" };
  },
};
AUTOMATION_ACTIONS["test.fail"] = {
  id: "test.fail",
  label: "Fail (test only)",
  params: [],
  run: async () => ({ ok: false, detail: "the timer is idle, so there is no next person" }),
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
});

describe("run by hand", () => {
  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: false, disarmed: false });
    sent.length = 0;
  });

  const rec = (over: Record<string, unknown> = {}) =>
    ruleFiringOnServiceStart({ action: { id: "test.record", params: {} }, ...over });
  const run = (id: string, o: { confirmed?: boolean; caller?: string } = {}) =>
    automationEngine.runNow(id, { caller: o.caller ?? "console", confirmed: o.confirmed });

  test("fires while its conditions fail, inside its cooldown, and when disabled", async () => {
    const id = await rec({
      enabled: false,
      cooldownSec: 3600,
      conditions: [{ id: "service.type-is", params: { serviceTypeId: "nope" } }],
    });
    const first = await run(id);
    assert.deepEqual(first, { status: 200, body: { outcome: "fired", detail: "sent" } });
    const second = await run(id); // the first run's cooldown does not stop a second by hand
    assert.equal(second.status, 200);
    assert.equal(sent.length, 2);
  });

  test("fires after oncePerService has been used, and does not use it up", async () => {
    const id = await rec({ oncePerService: true, cooldownSec: 0 });
    // The service key comes from the bus, so a snapshot has to have flowed
    // before the manual run for there to be a key to (wrongly) mark.
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await run(id);
    assert.equal(sent.length, 1);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(sent.length, 2, "the manual run did not consume the once-per-service fire");
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW + 2000);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 3000);
    assert.equal(sent.length, 2, "the automatic fire did consume it");
    await run(id);
    assert.equal(sent.length, 3, "and a manual run is still allowed after that");
  });

  test("is refused while disarmed, and nothing runs", async () => {
    const id = await rec();
    await automationEngine.setSettings({ disarmed: true });
    const r = await run(id);
    assert.equal(r.status, 409);
    assert.match((r.body as { error: string }).error, /disarmed/i);
    assert.equal(sent.length, 0);
  });

  test("simulate answers simulated and the action sends nothing", async () => {
    const id = await rec();
    await automationEngine.setSettings({ simulate: true });
    const r = await run(id);
    assert.deepEqual(r, { status: 200, body: { outcome: "simulated", detail: "would send" } });
    assert.equal(sent.length, 0);
    assert.equal(automationLog.list()[0].outcome, "simulated");
  });

  test("sets lastFiredAt: an automatic fire inside the cooldown is suppressed", async () => {
    const id = await rec({ cooldownSec: 3600 });
    await run(id);
    sent.length = 0;
    await automationEngine.__handleBroadcast("pco:live", live("preservice"), NOW);
    await automationEngine.__handleBroadcast("pco:live", live("item"), NOW + 1000);
    assert.equal(sent.length, 0);
    assert.ok(automationLog.list().some((e) => e.outcome === "suppressed" && /cooldown/i.test(e.detail)));
  });

  test("a confirm rule is refused 428 without confirmed, and runs with it", async () => {
    const id = await rec({ confirmRequired: true });
    const refused = await run(id);
    assert.equal(refused.status, 428);
    assert.equal(sent.length, 0);
    const done = await run(id, { confirmed: true });
    assert.equal(done.status, 200);
    assert.equal(sent.length, 1);
  });

  test("the log entry says it was manual and who ran it", async () => {
    const id = await rec();
    await run(id, { caller: "console" });
    const e = automationLog.list()[0];
    assert.equal(e.outcome, "fired");
    assert.equal(e.caller, "console");
    assert.match(e.detail, /\(manual\)/);
  });

  test("a failing action returns its own reason", async () => {
    const id = await rec({ action: { id: "test.fail", params: {} } });
    const r = await run(id);
    assert.deepEqual(r, {
      status: 200,
      body: { outcome: "failed", detail: "the timer is idle, so there is no next person" },
    });
    assert.equal(automationLog.list()[0].outcome, "failed");
  });

  test("an unknown rule is 404", async () => {
    assert.equal((await run("nope")).status, 404);
  });

  test("the server log names the rule, the caller and the outcome, scrubbed", async () => {
    const id = await rec({ name: "Doors\nforged line" });
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      await run(id, { caller: "ha token" });
    } finally {
      console.log = real;
    }
    const mine = lines.filter((l) => l.startsWith("[automation]") && l.includes("run by hand"));
    assert.equal(mine.length, 1);
    assert.match(mine[0], /from ha token: fired/);
    assert.ok(!mine[0].includes("\n"), "a newline in the rule name must not split the log line");
  });
});

// Rule edits used to save and broadcast silently, so an operator who lost 300
// rules in one evening had nothing to read on /log. One line per add, update
// and remove, tagged [automation].
describe("rule edits are logged", () => {
  const realLog = console.log;
  let lines: string[] = [];

  beforeEach(async () => {
    await automationEngine.init();
    lines = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  });

  after(() => {
    console.log = realLog;
  });

  const matching = (re: RegExp) => lines.filter((l) => re.test(l));

  test("add, update and remove each emit exactly one [automation] line", async () => {
    const id = await ruleFiringOnServiceStart({ name: "front wash" });
    assert.deepEqual(
      matching(/^\[automation\] rule added /),
      [`[automation] rule added "front wash" (${id})`],
      "adding a rule logged nothing, or logged more than once",
    );

    lines = [];
    await automationEngine.updateRule(id, { name: "front wash 2" });
    assert.deepEqual(
      matching(/^\[automation\] rule updated /),
      [`[automation] rule updated "front wash 2" (${id})`],
      "updating a rule logged nothing, or logged more than once",
    );

    lines = [];
    await automationEngine.removeRule(id);
    assert.deepEqual(
      matching(/^\[automation\] rule removed /),
      [`[automation] rule removed "front wash 2" (${id})`],
      "removing a rule logged nothing — the name must be captured before the filter",
    );
  });
});
