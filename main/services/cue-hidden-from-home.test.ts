// A cue kept out of Home Assistant — the per-cue "Home Assistant" switch.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - ABSENT MEANS SHOWN. The flag was added to cues that already existed, and a
//    rules file written before it must not lose every entity in the house.
//  - A HIDDEN PAIR'S HALVES DO NOT LEAK OUT AS BUTTONS. Skipping the pair
//    before its halves are counted as paired publishes both of them as
//    momentary buttons — the entity the operator hid, twice, under new ids.
//  - THE VERSION MOVES when the flag is flipped, or the integration never
//    re-reads and the entity stays in Home Assistant until a restart.
//  - VOICE STILL FIRES IT. Hidden is about entities, not about permission;
//    a hidden cue that stopped answering `POST /api/cues/<name>` would be a
//    silently disabled rule.
//
// Driven through the REAL engine — saved rules, the real rulesChanged path, the
// real manifest — because the version bump lives in none of the three pieces on
// its own.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "cue-hidden-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationEngine } = await import("./automation-engine.js");
const { cueManifest, manifestVersion } = await import("./cue-manifest.js");
const { homeAssistantYaml } = await import("./home-assistant-yaml.js");
const { CALL_TRIGGER_ID } = await import("./cue-aliases.js");
const { cuePairs, homeVisibilityParams, isHiddenFromHome } = await import("./cue-pairs.js");
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
});

/** A cue rule the engine will accept, with whatever trigger params on top. */
function cue(name: string, params: Record<string, string | number> = {}): Omit<Rule, "id"> {
  return {
    name: `Rule ${name}`,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name, ...params } },
    conditions: [],
    action: { id: "log.message", params: { message: `pressed ${name}` } },
    cooldownSec: 0,
    oncePerService: false,
  };
}

describe("the flag itself", () => {
  test("absent, blank and anything else all mean shown", () => {
    assert.equal(isHiddenFromHome({}), false);
    assert.equal(isHiddenFromHome({ homeAssistant: "" }), false);
    assert.equal(isHiddenFromHome({ homeAssistant: "shown" }), false);
    assert.equal(isHiddenFromHome({ homeAssistant: "yes" }), false);
    assert.equal(isHiddenFromHome({ homeAssistant: "hidden" }), true);
    assert.equal(isHiddenFromHome({ homeAssistant: " Hidden " }), true);
  });

  test("clearing it writes the key blank rather than dropping it", () => {
    assert.deepEqual(homeVisibilityParams(true), { homeAssistant: "hidden" });
    // Blank, not absent: a patch that merges params can only clear a key it
    // writes, so dropping it here would make the switch impossible to turn
    // back on.
    assert.deepEqual(homeVisibilityParams(false), { homeAssistant: "" });
  });

  test("a pair reads its ON half, and falls back to the OFF half", () => {
    const pair = (on: Record<string, string>, off: Record<string, string>) =>
      cuePairs([
        { ...cue("projectors_on", on), id: "on" },
        { ...cue("projectors_off", off), id: "off" },
      ])[0]!;
    assert.equal(pair({ homeAssistant: "hidden" }, {}).hiddenFromHome, true);
    // Hand-edited onto the OFF half only: read rather than ignored, so a
    // setting that is saved does something.
    assert.equal(pair({}, { homeAssistant: "hidden" }).hiddenFromHome, true);
    // Shown is stored BLANK, which is what absent looks like, so an ON half
    // cannot out-vote a hidden OFF half. The editor only writes the ON half;
    // the two disagree only in a hand-edited file.
    assert.equal(pair({ homeAssistant: "" }, { homeAssistant: "hidden" }).hiddenFromHome, true);
    assert.equal(pair({}, {}).hiddenFromHome, false);
  });
});

describe("the manifest", () => {
  test("hiding a pair drops the switch and moves the version", async () => {
    const on = await automationEngine.addRule(cue("projectors_on", { says: "Projectors on" }));
    await automationEngine.addRule(cue("projectors_off"));
    await automationEngine.addRule(cue("take_screens"));

    const before = await cueManifest();
    assert.deepEqual(before.switches.map((s) => s.id), ["projectors"]);

    const versionBefore = manifestVersion();
    await automationEngine.updateRule(on.id, {
      trigger: { id: CALL_TRIGGER_ID, params: { ...on.trigger.params, ...homeVisibilityParams(true) } },
    });
    assert.equal(manifestVersion() > versionBefore, true);

    const after = await cueManifest();
    assert.deepEqual(after.switches.map((s) => s.id), []);
    assert.deepEqual(after.buttons.map((b) => b.id), ["take_screens"]);
    assert.equal(after.version > versionBefore, true);
  });

  test("a hidden pair found through a former name leaks neither half", async () => {
    // The halves of a pair named `<base>_on`/`<base>_off` are kept out of the
    // buttons by the orphan filter whatever else happens, and a cue carrying
    // the flag itself is kept out by the flag. Neither covers a RENAMED half
    // that is hidden through its partner: `foo` pairs with `screens_off` only
    // through its former name and says nothing about Home Assistant, so a pair
    // skipped before it is counted as paired publishes `foo` as a momentary
    // button — the entity the operator hid, back under a new id.
    await automationEngine.addRule(cue("foo", { aliases: "screens_on" }));
    await automationEngine.addRule(cue("screens_off", homeVisibilityParams(true)));

    const m = await cueManifest();
    assert.deepEqual(m.switches.map((s) => s.id), []);
    assert.deepEqual(m.buttons.map((b) => b.id), []);
  });

  test("hiding a single cue drops the button and leaves the rest", async () => {
    const lone = await automationEngine.addRule(cue("take_screens"));
    await automationEngine.addRule(cue("house_lights"));

    await automationEngine.updateRule(lone.id, {
      trigger: {
        id: CALL_TRIGGER_ID,
        params: { ...lone.trigger.params, ...homeVisibilityParams(true) },
      },
    });
    assert.deepEqual((await cueManifest()).buttons.map((b) => b.id), ["house_lights"]);
  });

  test("showing it again brings the switch back", async () => {
    const on = await automationEngine.addRule(cue("projectors_on", homeVisibilityParams(true)));
    await automationEngine.addRule(cue("projectors_off"));
    assert.deepEqual((await cueManifest()).switches.map((s) => s.id), []);

    await automationEngine.updateRule(on.id, {
      trigger: {
        id: CALL_TRIGGER_ID,
        params: { ...on.trigger.params, ...homeVisibilityParams(false) },
      },
    });
    assert.deepEqual((await cueManifest()).switches.map((s) => s.id), ["projectors"]);
  });
});

describe("the generated YAML", () => {
  test("has no switch, no script and no rest_command for a hidden cue", async () => {
    await automationEngine.addRule(cue("projectors_on", homeVisibilityParams(true)));
    await automationEngine.addRule(cue("projectors_off"));
    await automationEngine.addRule(cue("take_screens", homeVisibilityParams(true)));
    await automationEngine.addRule(cue("house_lights"));

    const yaml = homeAssistantYaml(automationEngine.listRules(), "http://192.0.2.10:8788");
    assert.equal(yaml.includes("su_house_lights"), true);
    for (const gone of ["projectors_on", "projectors_off", "take_screens"]) {
      assert.equal(yaml.includes(gone), false, `${gone} is still in the YAML`);
    }
    // The OFF half goes with the ON half. Reading each cue's own flag would
    // leave `su_projectors_off` behind — a rest_command in Home Assistant for
    // half of the switch the operator hid.
    assert.equal(yaml.includes("stage_utility_projectors"), false);
  });

  test("every cue hidden emits no empty rest_command mapping", async () => {
    await automationEngine.addRule(cue("take_screens", homeVisibilityParams(true)));
    const yaml = homeAssistantYaml(automationEngine.listRules(), "http://192.0.2.10:8788");
    // `rest_command:` with nothing under it is a null value, and Home Assistant
    // refuses the whole file over it.
    assert.equal(yaml.includes("rest_command:"), false);
    assert.equal(yaml.includes("hidden from Home Assistant"), true);
  });
});

describe("voice", () => {
  test("still fires a hidden cue", async () => {
    // Hidden is about which entities Home Assistant is told to create. A hidden
    // cue that stopped answering would be a rule silently disabled by a
    // presentation setting.
    await automationEngine.addRule(cue("take_screens", homeVisibilityParams(true)));
    const result = await automationEngine.callByName("take_screens", { caller: "test" });
    assert.equal(result.status, 200);
  });
});
