// A cue's FORMER names, and the one namespace they share with its live name.
//
// A cue name is the URL Home Assistant calls (`rest_command.su_<name>`), and the
// HomeKit switch a household asks for was created from that command. So a rename
// keeps the old name answering — and that makes a former name a live URL, which
// is why the engine refuses to let a second rule take one:
//
//  - a name may not be another rule's former name. Allowing it would silently
//    take over an already pasted Home Assistant switch, so a switch labelled
//    "Projectors" would start driving whatever the new rule presses.
//  - a former name may not be another rule's name. Same collision, arrived at
//    from the other side, and the loser is whichever the resolver happens to
//    find first.
//
// And resolution has to prefer a live NAME over anybody's former one, or a rule
// called by its own name could be shadowed by a rule that used to be called that.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "cue-aliases-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { errorMessage } = await import("./errors.js");
const { automationEngine } = await import("./automation-engine.js");
const { automationLog } = await import("./automation-log.js");
const { CALL_TRIGGER_ID } = await import("./automation-triggers.js");
const { MAX_ALIASES, encodeAliases, nextAliases, parseAliases } = await import("./cue-aliases.js");
type Rule = import("../types/automation.js").Rule;

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

before(async () => {
  await automationEngine.init();
  await automationEngine.setSettings({ simulate: true, disarmed: false });
});

beforeEach(async () => {
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
});

/** A cue rule, named and optionally carrying former names. */
function cue(name: string, aliases: string[] = [], ruleName = name) {
  return {
    name: ruleName,
    enabled: true,
    trigger: {
      id: CALL_TRIGGER_ID,
      params: { name, aliases: encodeAliases(aliases) } as Record<string, string | number>,
    },
    conditions: [],
    action: { id: "log.message", params: { message: "pressed" } },
    cooldownSec: 0,
    oncePerService: false,
  };
}

/** The message a refused save produced, or "" when it was accepted. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (err) {
    return errorMessage(err);
  }
}

describe("the encoding", () => {
  test("is comma-joined, trimmed, lowercased and de-duplicated", () => {
    assert.deepEqual(parseAliases({ aliases: "projectors_on, OLD_name ,,projectors_on" }), [
      "projectors_on",
      "old_name",
    ]);
    assert.deepEqual(parseAliases({}), []);
    assert.deepEqual(parseAliases({ aliases: "" }), []);
    assert.equal(encodeAliases([]), "");
  });

  test("a rename appends the old name, oldest first, capped", () => {
    assert.deepEqual(nextAliases([], "a", "b"), ["a"]);
    assert.deepEqual(nextAliases(["a"], "b", "c"), ["a", "b"]);
    // Six renames keep the last five, oldest dropped: every former name is a
    // live URL, and one per week forever is unbounded growth.
    let list: string[] = [];
    for (const [from, to] of [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "f"], ["f", "g"]]) {
      list = nextAliases(list, from!, to!);
    }
    assert.deepEqual(list, ["b", "c", "d", "e", "f"]);
    assert.equal(list.length, MAX_ALIASES);
  });

  test("renaming BACK to a former name drops it from the list", () => {
    // Otherwise the cue holds its own name as a former name, which the engine
    // refuses to save — a rename that threw where it should have been a no-op.
    assert.deepEqual(nextAliases(["projectors_on"], "screens_on", "projectors_on"), ["screens_on"]);
  });
});

describe("one namespace, both directions", () => {
  test("a new rule may not take a name that is another rule's former name", async () => {
    await automationEngine.addRule(cue("screens_on", ["projectors_on"], "Screens ON"));
    const why = await refusal(automationEngine.addRule(cue("projectors_on")));
    assert.match(why, /former name of "Screens ON"/);
    assert.equal(automationEngine.cueRules().length, 1, "the second rule was created anyway");
  });

  test("a new rule may not claim a former name another rule's NAME already uses", async () => {
    await automationEngine.addRule(cue("projectors_on", [], "Projectors ON"));
    const why = await refusal(automationEngine.addRule(cue("screens_on", ["projectors_on"])));
    assert.match(why, /former name "projectors_on" is already used by "Projectors ON"/);
    assert.equal(automationEngine.cueRules().length, 1);
  });

  test("nor a former name another rule already holds as a former name", async () => {
    await automationEngine.addRule(cue("screens_on", ["projectors_on"], "Screens ON"));
    const why = await refusal(automationEngine.addRule(cue("lights_on", ["projectors_on"])));
    assert.match(why, /already a former name of "Screens ON"/);
  });

  test("a rule may keep its own former names on an ordinary save", async () => {
    // The obvious way to write the check refuses this: the rule's aliases clash
    // with themselves, and every save of a renamed cue would 400.
    const rule = await automationEngine.addRule(cue("screens_on", ["projectors_on"]));
    const why = await refusal(automationEngine.updateRule(rule.id, { name: "Renamed in the UI" }));
    assert.equal(why, "");
    assert.deepEqual(automationEngine.cueAliasesOf(automationEngine.listRules()[0]!), ["projectors_on"]);
  });

  test("a cue may not hold its own name as a former one", async () => {
    const why = await refusal(automationEngine.addRule(cue("screens_on", ["screens_on"])));
    assert.match(why, /own name, not a former one/);
  });

  test("a malformed former name is refused like a malformed name", async () => {
    const why = await refusal(automationEngine.addRule(cue("screens_on", ["Projectors ON!"])));
    assert.match(why, /former cue name — use lower_snake_case/);
  });

  test("removing a former name frees it for another rule", async () => {
    const rule = await automationEngine.addRule(cue("screens_on", ["projectors_on"]));
    await automationEngine.updateRule(rule.id, {
      trigger: { id: CALL_TRIGGER_ID, params: { name: "screens_on", aliases: "" } },
    });
    const why = await refusal(automationEngine.addRule(cue("projectors_on")));
    assert.equal(why, "", "the freed name is still refused");
    assert.equal(automationEngine.cueRules().length, 2);
  });
});

describe("resolution", () => {
  test("a call through a former name reaches the cue", async () => {
    await automationEngine.addRule(cue("screens_on", ["projectors_on"], "Screens ON"));
    const r = await automationEngine.callByName("projectors_on", { caller: "Home Assistant" });
    assert.equal(r.status, 200);
    assert.equal(automationLog.list().filter((e) => e.outcome === "simulated").length, 1);
  });

  test("and is case- and whitespace-insensitive, like a name", async () => {
    await automationEngine.addRule(cue("screens_on", ["projectors_on"]));
    assert.equal((await automationEngine.callByName(" PROJECTORS_ON ", { caller: "curl" })).status, 200);
  });

  test("A LIVE NAME WINS over another rule's former name", async () => {
    // The rule holding `projectors_on` as a former name is FIRST in the file, so
    // a resolver that looked at names and aliases in one pass would find it
    // first and press the wrong thing.
    await automationEngine.addRule(cue("screens_on", [], "Screens ON"));
    await automationEngine.addRule(cue("projectors_on", [], "Projectors ON"));

    // Written straight onto the loaded rules, because the save-time check
    // refuses exactly this state — and that is the point: a rules file restored
    // from a backup written before that check existed, or hand-edited, arrives
    // like this, and resolution is the guard that still has to be right. There
    // is no production setter for it, and adding one for a test would be worse.
    const loaded = (automationEngine as unknown as { rules: Rule[] }).rules;
    loaded[0]!.trigger.params.aliases = "projectors_on";

    await automationEngine.callByName("projectors_on", { caller: "Home Assistant" });
    assert.deepEqual(
      automationLog.list().map((e) => e.ruleName),
      ["Projectors ON"],
      "a former name shadowed the rule that actually owns the name",
    );
  });

  test("an unknown name is still unknown, former names or not", async () => {
    await automationEngine.addRule(cue("screens_on", ["projectors_on"]));
    const r = await automationEngine.callByName("nothing_like_it", { caller: "curl" });
    assert.equal(r.status, 404);
  });
});
