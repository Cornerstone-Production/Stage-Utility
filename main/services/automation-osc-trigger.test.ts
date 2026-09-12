// Inbound OSC as a rule trigger.
//
// Two halves, tested at two altitudes:
//
//  - the edge itself, against the REGISTRY, because that is where the "did this
//    change" logic lives and where a level test would hide;
//  - the whole path, against the REAL engine fed by the REAL manager's own
//    feedback snapshot, because a trigger that reads the wrong key shape is
//    green in every registry test ever written. The manager decides the keys;
//    nothing but running both together proves the trigger reads them.
//
// No packet leaves this process. The manager's receive() is called directly.

import assert from "node:assert/strict";
import { describe, test, before, beforeEach, after } from "node:test";
import * as dgram from "node:dgram";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-osc-trigger-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { AUTOMATION_TRIGGERS, triggersForChannel } = await import("./automation-triggers.js");
const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");
const { oscManager, oscDeps } = await import("./osc-manager.js");
const { encodeMessage } = await import("./osc-codec.js");

const NOW = Date.parse("2026-09-11T15:00:00Z");
const t = AUTOMATION_TRIGGERS["osc.value"];

/** An osc:feedback payload, the shape osc-manager broadcasts. */
const feed = (values: Record<string, number | string | boolean>) => ({ values });

after(async () => {
  oscManager.stop();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("the osc.value edge", () => {
  const P = { address: "/record", match: "equals", value: "1" };

  test("fires when the value changes into a match", () => {
    assert.equal(t.didFire(feed({ "*::/record": 0 }), feed({ "*::/record": 1 }), P, NOW), true);
  });

  test("does NOT fire on a level that merely persists", () => {
    // THE EDGE GUARD. osc:feedback re-sends the WHOLE map whenever any one
    // address changes, so a level test would fire this rule every time somebody
    // moved an unrelated fader on the same desk.
    const same = { "*::/record": 1, "*::/ch/01/mix/fader": 0.5 };
    assert.equal(
      t.didFire(feed(same), feed({ ...same, "*::/ch/01/mix/fader": 0.6 }), P, NOW),
      false,
      "a rule watching /record fired because a different address moved",
    );
  });

  test("fires the first time an address appears carrying the value", () => {
    // Absent before, matching after. The address showing up IS the event; the
    // engine's own seeding guard is what stops this happening on startup.
    assert.equal(t.didFire(feed({}), feed({ "*::/record": 1 }), P, NOW), true);
  });

  test("does not fire when the address goes away", () => {
    assert.equal(t.didFire(feed({ "*::/record": 1 }), feed({}), P, NOW), false);
  });

  test("the rule's text is compared as a NUMBER when both sides read as one", () => {
    // The operator types text and cannot know whether their console picked i, f
    // or s for the argument. Every case here is one a plain string compare gets
    // WRONG — `1.0 === 1` in JS, so a received float proves nothing; it is
    // "1.0" on the RULE side that needs the coercion.
    const eq = (recv: number | string | boolean, want: string) =>
      t.didFire(feed({ "*::/record": "seed" }), feed({ "*::/record": recv }), { ...P, value: want }, NOW);
    assert.equal(eq(1, "1.0"), true, 'a rule typed "1.0" must match a received 1');
    assert.equal(eq(0.5, ".5"), true, 'a rule typed ".5" must match a received 0.5');
    assert.equal(eq("1", "1.0"), true, 'a string-typed reply of "1" must match a rule typed "1.0"');
    assert.equal(eq(2, "1.0"), false, "and it must still not match a different number");
  });

  test("true/false match an OSC T/F", () => {
    const on = { ...P, value: "true" };
    assert.equal(t.didFire(feed({ "*::/record": false }), feed({ "*::/record": true }), on, NOW), true);
    assert.equal(t.didFire(feed({ "*::/record": true }), feed({ "*::/record": false }), on, NOW), false);
  });

  test("a string value matches case-insensitively", () => {
    const p = { address: "/mode", match: "equals", value: "rehearsal" };
    assert.equal(t.didFire(feed({ "*::/mode": "SHOW" }), feed({ "*::/mode": "Rehearsal" }), p, NOW), true);
  });

  test("a blank value matches nothing", () => {
    // An unfinished rule must not fire on every message the address carries.
    //
    // Asserted against a received ZERO and a received EMPTY STRING, because
    // those are the two the missing check lets through: `Number("")` is 0, so a
    // blank rule value silently means "equals zero" and a received 1 misses it
    // whether the check is there or not.
    const p = { address: "/record", match: "equals", value: "" };
    assert.equal(t.didFire(feed({ "*::/record": 5 }), feed({ "*::/record": 0 }), p, NOW), false,
      "a blank rule value armed itself on zero");
    assert.equal(t.didFire(feed({ "*::/record": "x" }), feed({ "*::/record": "" }), p, NOW), false,
      "a blank rule value matched an empty string");
    assert.equal(t.didFire(feed({}), feed({ "*::/record": 1 }), p, NOW), false);
  });

  test("crossed above fires on the snapshot that crossed, and not after", () => {
    const p = { address: "/spl", match: "above", value: "0.8" };
    assert.equal(t.didFire(feed({ "*::/spl": 0.7 }), feed({ "*::/spl": 0.9 }), p, NOW), true);
    assert.equal(t.didFire(feed({ "*::/spl": 0.9 }), feed({ "*::/spl": 0.95 }), p, NOW), false);
  });

  test("crossed below is the same in reverse", () => {
    const p = { address: "/spl", match: "below", value: "0.8" };
    assert.equal(t.didFire(feed({ "*::/spl": 0.9 }), feed({ "*::/spl": 0.7 }), p, NOW), true);
    assert.equal(t.didFire(feed({ "*::/spl": 0.7 }), feed({ "*::/spl": 0.6 }), p, NOW), false);
  });

  test("no baseline, no crossing", () => {
    // The first value an address ever carries is not a crossing, whichever side
    // of the threshold it lands on.
    const p = { address: "/spl", match: "above", value: "0.8" };
    assert.equal(
      t.didFire(feed({}), feed({ "*::/spl": 0.9 }), p, NOW),
      false,
      "an address appearing already above the threshold is not a crossing",
    );
  });

  test("a blank threshold is not a threshold of zero", () => {
    // `Number("")` is 0 AND finite, so a half-built "crossed above" rule with
    // nothing typed in Value would arm itself on zero and fire the moment the
    // address went positive.
    const p = { address: "/spl", match: "above", value: "" };
    assert.equal(
      t.didFire(feed({ "*::/spl": -1 }), feed({ "*::/spl": 1 }), p, NOW),
      false,
      "a crossing with no threshold typed fired on zero",
    );
    assert.equal(
      t.didFire(feed({ "*::/spl": 1 }), feed({ "*::/spl": -1 }), { ...p, match: "below" }, NOW),
      false,
    );
  });

  test("a non-numeric value cannot cross anything", () => {
    // The discriminating case is a non-numeric BEFORE and a numeric AFTER: two
    // non-numeric strings coerce to the same thing under any reading, so they
    // cannot cross whether oscNumber refuses them or quietly calls them zero.
    const p = { address: "/mode", match: "above", value: "0.5" };
    assert.equal(
      t.didFire(feed({ "*::/mode": "show" }), feed({ "*::/mode": 1 }), p, NOW),
      false,
      "a word is not a baseline — reading it as zero invents a crossing",
    );
    assert.equal(
      t.didFire(feed({ "*::/mode": 1 }), feed({ "*::/mode": "show" }), { ...p, match: "below" }, NOW),
      false,
      "a value that has become a word has not fallen below anything",
    );
    assert.equal(t.didFire(feed({ "*::/mode": "show" }), feed({ "*::/mode": "rehearsal" }), p, NOW), false);
  });

  test("an address without a leading slash matches nothing", () => {
    const p = { address: "record", match: "equals", value: "1" };
    assert.equal(t.didFire(feed({ "*::record": 0 }), feed({ "*::record": 1 }), p, NOW), false);
  });

  test("a named target reads that target's key, not the wildcard", () => {
    const p = { address: "/record", target: "abc", match: "equals", value: "1" };
    assert.equal(
      t.didFire(feed({ "*::/record": 0 }), feed({ "*::/record": 1 }), p, NOW),
      false,
      "a rule scoped to one target fired on a value from an unattributed sender",
    );
    assert.equal(
      t.didFire(feed({ "abc::/record": 0 }), feed({ "abc::/record": 1 }), p, NOW),
      true,
      "a rule scoped to a target did not read that target's key",
    );
  });

  test("argument 1 reads the #1 key", () => {
    const p = { address: "/fader", argument: 1, match: "above", value: "0.5" };
    assert.equal(
      t.didFire(feed({ "*::/fader": 3, "*::/fader#1": 0.4 }), feed({ "*::/fader": 3, "*::/fader#1": 0.6 }), p, NOW),
      true,
      "argument 1 was not read — the rule looked at the bare address key",
    );
    // Argument 0 of the same message is the channel number, and it did not move.
    assert.equal(
      t.didFire(
        feed({ "*::/fader": 3, "*::/fader#1": 0.4 }),
        feed({ "*::/fader": 3, "*::/fader#1": 0.6 }),
        { ...p, argument: 0 },
        NOW,
      ),
      false,
    );
  });

  test("a Match nobody picked reads as equals, rather than as nothing", () => {
    // The editor stores "" when an operator picks a Match and then re-picks
    // "Pick one…", and there is no required-param validation to stop the save.
    // Reading that as equals is the house answer — an unconfigured rule fires
    // rather than silently never firing, the same call PVP's blank layer param
    // makes — and it is now a decision in the code rather than a fall-through.
    for (const match of ["", "nonsense", undefined]) {
      assert.equal(
        t.didFire(feed({ "*::/record": 0 }), feed({ "*::/record": 1 }), { address: "/record", match, value: "1" }, NOW),
        true,
        `match ${JSON.stringify(match)} must behave as equals, not as a rule that can never fire`,
      );
    }
  });

  test("it is registered on the channel the manager broadcasts", () => {
    assert.equal(t.channel, "osc:feedback");
    assert.deepEqual(
      triggersForChannel("osc:feedback").map((x) => x.id),
      ["osc.value"],
    );
  });
});

// ── The whole path ───────────────────────────────────────────────────────────
//
// The registry tests above all write the key shape out by hand, so every one of
// them would stay green if osc-manager changed how it keys the map. These feed
// the ENGINE the MANAGER's own snapshot.

const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const DESK_IP = "192.0.2.30"; // TEST-NET-1, routable nowhere

/** Deliver a message to the manager and hand the engine what it now holds. */
async function deliver(address: string, args: { type: "i" | "f" | "s"; value: number | string }[]) {
  oscManager.receive(encodeMessage(address, args), DESK_IP);
  await automationEngine.__handleBroadcast("osc:feedback", oscManager.getFeedback(), Date.now());
}

const fires = () =>
  automationLog.list().filter((e) => e.outcome === "fired" || e.outcome === "simulated").length;

async function onlyRule(params: Record<string, string | number>): Promise<void> {
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  await automationEngine.addRule({
    name: "osc rule",
    enabled: true,
    trigger: { id: "osc.value", params },
    conditions: [],
    action: { id: "log.message", params: { message: "fired" } },
    cooldownSec: 0,
    oncePerService: false,
  });
}

describe("a rule driven by real inbound OSC", () => {
  before(async () => {
    oscDeps.lookup = async () => [];
    await fs.writeFile(
      path.join(TMP, "osc-targets.json"),
      JSON.stringify([
        { id: TARGET_ID, name: "Desk", enabled: true, config: { host: DESK_IP, port: 8000 } },
      ]),
      "utf8",
    );
    // An OS-assigned port, so this never contends with a real instance on
    // udp/9000 — nothing here needs the socket, but init binds one regardless.
    const probe = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", resolve));
    const { port } = probe.address();
    await new Promise<void>((resolve) => probe.close(resolve));
    await oscManager.setFeedbackPort(port);
    await oscManager.reloadTargets();
  });

  beforeEach(async () => {
    await automationEngine.init();
    await automationEngine.setSettings({ simulate: true, disarmed: false });
  });

  test("a message from the configured target fires a rule scoped to it", async () => {
    await onlyRule({ address: "/e2e/record", target: TARGET_ID, match: "equals", value: "1" });
    await deliver("/e2e/record", [{ type: "f", value: 0 }]); // seeds the channel
    await deliver("/e2e/record", [{ type: "f", value: 1 }]);
    assert.equal(fires(), 1, "the trigger did not read the key osc-manager actually writes");
  });

  test("the same rule left on any target fires too", async () => {
    await onlyRule({ address: "/e2e/any", match: "equals", value: "1" });
    await deliver("/e2e/any", [{ type: "i", value: 0 }]);
    await deliver("/e2e/any", [{ type: "i", value: 1 }]);
    assert.equal(fires(), 1);
  });

  test("THE SEEDING GUARD: the first snapshot after a restart never fires", async () => {
    // The whole feedback map arrives at once on the first broadcast. Reading
    // that as a set of transitions would fire every OSC rule in the file the
    // moment the app came back up, mid-service, unattended.
    await onlyRule({ address: "/e2e/boot", match: "equals", value: "1" });
    await deliver("/e2e/boot", [{ type: "i", value: 1 }]);
    assert.equal(fires(), 0);
  });

  test("a rule on argument 1 reads the value, not the channel number", async () => {
    // THE TRUNCATION GUARD, end to end: this message used to reach the map as
    // its first argument alone, so `#1` never existed and this rule could not
    // have been written at all.
    await onlyRule({ address: "/e2e/fader", argument: 1, match: "above", value: "0.5" });
    await deliver("/e2e/fader", [{ type: "i", value: 7 }, { type: "f", value: 0.25 }]);
    await deliver("/e2e/fader", [{ type: "i", value: 7 }, { type: "f", value: 0.75 }]);
    assert.equal(fires(), 1, "the second argument never reached the engine");
  });

  test("an unrelated address moving does not fire the rule", async () => {
    // The watched address is left AT the value the rule wants, and then left
    // alone. A level test would fire on every one of the /e2e/noisy snapshots
    // that follow, because each carries /e2e/quiet still reading 1 — which is
    // the whole failure mode, and a watched address sitting at a NON-matching
    // value would hide it behind the value check instead.
    await onlyRule({ address: "/e2e/quiet", match: "equals", value: "1" });
    await deliver("/e2e/quiet", [{ type: "i", value: 0 }]);
    await deliver("/e2e/quiet", [{ type: "i", value: 1 }]); // the one real edge
    assert.equal(fires(), 1, "the edge into the value must fire once");
    await deliver("/e2e/noisy", [{ type: "i", value: 1 }]);
    await deliver("/e2e/noisy", [{ type: "i", value: 2 }]);
    await deliver("/e2e/noisy", [{ type: "i", value: 3 }]);
    assert.equal(fires(), 1, "a rule fired again because a DIFFERENT address moved");
  });

  test("a BANG is swallowed when it is the first thing on the channel", async () => {
    // Documented, not a defect: the engine seeds `prev` on the first snapshot
    // per channel and never evaluates it, which is the guard that stops a
    // restart mid-service firing every rule at once. A bang is stored as `true`
    // and stays `true`, so a sender that has the feedback port to itself and
    // only ever bangs produces exactly one snapshot — the baseline — and the
    // rule never fires at all.
    //
    // Pinned because docs/automation.md and the trigger's help text now say so,
    // and they said the opposite until this was driven.
    await onlyRule({ address: "/e2e/bang", match: "equals", value: "true" });
    for (let i = 0; i < 4; i++) await deliver("/e2e/bang", []);
    assert.equal(fires(), 0, "a bang alone on a fresh channel must not be claimed to fire once");
  });

  test("a BANG fires once when the channel already carries traffic", async () => {
    await onlyRule({ address: "/e2e/bang2", match: "equals", value: "true" });
    await deliver("/e2e/other", [{ type: "i", value: 1 }]); // seeds the channel
    for (let i = 0; i < 4; i++) await deliver("/e2e/bang2", []);
    assert.equal(fires(), 1, "once seeded, the bang's one edge must fire — and only once");
  });

  test("an enabled OSC rule puts osc:feedback in demand", async () => {
    for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
    assert.equal(automationEngine.wantsChannel("osc:feedback"), false, "no rules, no demand");
    await onlyRule({ address: "/e2e/demand", match: "equals", value: "1" });
    assert.equal(automationEngine.wantsChannel("osc:feedback"), true);
  });
});
