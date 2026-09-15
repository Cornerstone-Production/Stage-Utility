// A rules file this build did not write, driven end to end through the real bus.
//
// automation-rules.json is a CONFIG store: exported, imported, backed up and
// restored, and hand-editable. So the ids in it are strings the process did not
// author, and two of them used to be fatal:
//
//   - `AUTOMATION_CONDITIONS["constructor"]` answered with `Object`, which is
//     truthy, so `if (!def) return c.id` waved it through and `def.holds(...)`
//     threw `def.holds is not a function`;
//   - that throw happened inside `void this.handleBroadcast(...)`, a
//     fire-and-forget with nowhere for a rejection to go. On Node's default an
//     unhandled rejection EXITS THE PROCESS — so a restored archive carrying one
//     bad id took the server down on the next broadcast, mid-service.
//
// Everything here goes through the REAL store, the REAL engine and the REAL
// broadcaster — writing the file, calling init(), and publishing on the bus
// rather than calling the private handler. A unit test over
// firstFailingCondition would not have caught the second half.

import assert from "node:assert/strict";
import { test, describe, after, before } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-rules-disk-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

/**
 * Anything that escaped a promise nobody awaited.
 *
 * Registered BEFORE the dynamic imports below, for two reasons. Registering a
 * listener at all is what stops node's default — exit non-zero — from killing
 * this file, so the assertion has to read the array rather than infer anything
 * from the run finishing. And importing the service graph is itself a chance for
 * an unrelated rejection to escape, which registering inside before() would let
 * kill the file instead of recording it. The assertion counts only what arrives
 * during the broadcast, so an unrelated one cannot fail this.
 */
const escaped: unknown[] = [];
const onUnhandled = (e: unknown) => escaped.push(e);
process.on("unhandledRejection", onUnhandled);

/**
 * A rules file with a prototype member name in every id position a rule has.
 *
 * Written as bytes rather than through addRule, because addRule is not the path
 * that matters: a restore drops the file in and the next boot reads it.
 */
const RULES = [
  {
    id: "rule-bad-condition",
    name: "condition named after a prototype member",
    enabled: true,
    trigger: { id: "pco.service-started", params: {} },
    conditions: [{ id: "constructor", params: {} }],
    action: { id: "log.message", params: { message: "must not run" } },
    cooldownSec: 0,
    oncePerService: false,
  },
  {
    id: "rule-bad-action",
    name: "action named after a prototype member",
    enabled: true,
    trigger: { id: "pco.service-started", params: {} },
    conditions: [],
    action: { id: "__proto__", params: {} },
    cooldownSec: 0,
    oncePerService: false,
  },
  {
    id: "rule-bad-trigger",
    name: "trigger named after a prototype member",
    enabled: true,
    trigger: { id: "valueOf", params: {} },
    conditions: [],
    action: { id: "log.message", params: { message: "must not run" } },
    cooldownSec: 0,
    oncePerService: false,
  },
];

await fs.writeFile(path.join(TMP, "automation-rules.json"), JSON.stringify(RULES), "utf-8");

const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");
const { broadcast } = await import("./broadcaster.js");
const { errorMessage } = await import("./errors.js");

before(async () => {
  await automationEngine.init();
  // Simulate: an action must never reach real gear from a test. Every rule here
  // is expected to be refused before its action anyway.
  await automationEngine.setSettings({ simulate: true, disarmed: false });
  await automationLog.clear();
});

after(async () => {
  process.off("unhandledRejection", onUnhandled);
  // Retries because the engine stays subscribed to the bus for the life of the
  // process and the automation log writes after the last case returns: a plain
  // rm races it and fails the FILE with ENOTEMPTY while every case passed.
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const live = (mode: string) => ({ mode, currentItemTitle: null, serviceTimeId: "st1" });

/**
 * Wait for `ready`, or give up after a second.
 *
 * broadcast() does not await the listener, so there is nothing to await here
 * either. A fixed sleep was flaky under a loaded test run; polling a condition
 * with a deadline says what it is waiting FOR, and still fails rather than
 * hanging if the thing never happens.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("a restored rules file naming prototype members", () => {
  test("the engine loaded it rather than dropping it on the floor", () => {
    // The premise of everything below: if the store had refused the file, the
    // cases would pass with nothing to evaluate.
    const ids = automationEngine.listRules().map((r) => r.id);
    assert.deepEqual(ids.sort(), ["rule-bad-action", "rule-bad-condition", "rule-bad-trigger"]);
  });

  test("a broadcast over it does not take the process down", async () => {
    // Only what escapes DURING the broadcast counts — see the note on `escaped`.
    const before = escaped.length;
    // The real bus, the real listener, the real fire-and-forget call. The seed
    // path returns before handleBroadcast's first await, so it needs no wait.
    broadcast("pco:live", live("preservice"));
    broadcast("pco:live", live("item")); // the edge every rule here triggers on
    // Both surviving rules record an outcome; waiting for them is what makes
    // this deterministic rather than a sleep long enough to usually work.
    await until(
      () => automationLog.list().length >= 2 || escaped.length > before,
      "the engine to finish evaluating pco:live",
    );
    assert.deepEqual(
      escaped.slice(before).map(errorMessage),
      [],
      "a rejection escaped handleBroadcast — on Node's default that is the server exiting",
    );
  });

  test("and every bad rule is REPORTED rather than silently skipped", () => {
    // An operator has to be able to find out why nothing happened.
    const byRule = new Map(automationLog.list().map((e) => [e.ruleId, e]));

    const condition = byRule.get("rule-bad-condition");
    assert.ok(condition, "the condition rule left no trace at all");
    assert.equal(condition.outcome, "condition-not-met");

    const action = byRule.get("rule-bad-action");
    assert.ok(action, "the action rule left no trace at all");
    assert.equal(action.outcome, "failed");
    assert.match(action.detail, /unknown action "__proto__"/);

    // A trigger nothing recognises has no channel, so it is never reached — it
    // leaves no entry, and that is correct rather than a gap: a rule whose
    // trigger does not exist has had nothing happen to it.
    assert.equal(byRule.get("rule-bad-trigger"), undefined);
  });

  test("nothing fired", () => {
    const fired = automationLog.list().filter((e) => e.outcome === "fired" || e.outcome === "simulated");
    assert.deepEqual(fired, [], "a rule with a prototype-named id reached its action");
  });
});
