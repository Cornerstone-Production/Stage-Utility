// The cues the app ships — see builtin-cues.ts.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - THE TABLE IS REAL. Every action id in it exists in AUTOMATION_ACTIONS and
//    every state ref parses. A typo in either is a cue that appears in Home
//    Assistant, is pressed during a service, and answers "no action" — or a
//    switch that reads unknown forever with nothing anywhere saying why.
//  - THE COUNT IS EXACT. A floor with slack is how three config stores went
//    missing from every backup with the suite green; here it would be how a
//    whole integration's built-ins stopped being offered.
//  - THE FIXED SWITCHES BIND WHAT THEIR ACTION IMPLIES. The design is that a
//    built-in switch is the pair `implicitStateBinding` would have produced, so
//    the two are compared rather than trusted to stay in step.
//  - A DISABLED INTEGRATION OFFERS NOTHING. Otherwise Home Assistant carries an
//    OBS recording switch on an install with no OBS.
//  - A STORED RULE WINS. An install that built its own OBS pair last week must
//    not get a second entity under the same name on upgrade.
//
// NOT tested here: that the manifest carries `builtin: true` and the tone (see
// cue-manifest.test.ts), and that the set changing bumps the version (see
// builtin-cues-manifest.test.ts).

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// integration-manager and pvp-service resolve the data directory at import.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "builtin-cues-"));

const {
  BUILTIN_FIXED_BUTTONS,
  BUILTIN_FIXED_SWITCHES,
  BUILTIN_ID_PREFIX,
  __resetBuiltinCues,
  builtinCueRules,
  builtinCuesDeps,
  builtinInputsChanged,
  builtinTone,
  isBuiltinRule,
  layerButtons,
  layerSlug,
  layerSwitches,
  reservedCueNames,
} = await import("./builtin-cues.js");
const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
const { parseAppStateRef } = await import("./app-state-sources.js");
const { implicitStateBinding, cuePairs } = await import("./cue-pairs.js");
const { isValidCueName } = await import("./automation-triggers.js");
const { CALL_TRIGGER_ID } = await import("./cue-aliases.js");
type Rule = import("../types/automation.js").Rule;

let ENABLED = new Set<string>();
let CONNECTED = new Set<string>();
let LAYERS: string[] = [];
let CHANGED = 0;
let LOG: string[] = [];

const realLog = console.log;

beforeEach(() => {
  ENABLED = new Set(["obs", "reaper", "pvp"]);
  CONNECTED = new Set(["planning-center"]);
  LAYERS = [];
  CHANGED = 0;
  LOG = [];
  builtinCuesDeps.enabled = () => ENABLED;
  builtinCuesDeps.connected = () => CONNECTED;
  builtinCuesDeps.pvpLayers = () => LAYERS;
  builtinCuesDeps.changed = () => {
    CHANGED++;
  };
  __resetBuiltinCues();
  console.log = (...args: unknown[]) => {
    LOG.push(args.map(String).join(" "));
  };
});

/** Restore the console for the reporter between files. */
process.on("exit", () => {
  console.log = realLog;
});

/** One stored cue, as the engine holds it. */
function stored(name: string, label = `Rule ${name}`): Rule {
  return {
    id: name,
    name: label,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name } },
    conditions: [],
    action: { id: "log.message", params: { text: "x" } },
    cooldownSec: 0,
    oncePerService: false,
  };
}

const cueNames = (rules: Rule[]): string[] =>
  rules.map((r) => String(r.trigger.params.name));

/** The count lines said so far. Read through a copy: `assert.deepEqual(LOG, [])`
 *  is an assertion signature, and narrows LOG itself to never[] for the rest of
 *  the test. */
const offeredLines = (): string[] => [...LOG].filter((l) => l.includes("built-in cues offered"));

describe("the table", () => {
  test("every action id exists and every state ref parses", () => {
    const layer = "Lower Thirds";
    const defs = [
      ...BUILTIN_FIXED_SWITCHES,
      ...layerSwitches(layer, layerSlug(layer)),
    ];
    for (const s of defs) {
      assert.ok(AUTOMATION_ACTIONS[s.on.id], `${s.base} ON action ${s.on.id} does not exist`);
      assert.ok(AUTOMATION_ACTIONS[s.off.id], `${s.base} OFF action ${s.off.id} does not exist`);
      assert.ok(
        parseAppStateRef(s.binding.variable),
        `${s.base} state ref ${s.binding.variable} does not parse`,
      );
      // An ON value equal to the OFF value is a switch that could never be
      // read; stateBindingProblem refuses it from an operator, and the table
      // must not be able to ship it either.
      assert.notEqual(s.binding.onValue, s.binding.offValue, `${s.base} on and off values match`);
      for (const n of [`${s.base}_on`, `${s.base}_off`]) {
        assert.ok(isValidCueName(n), `${n} is not a usable cue name`);
      }
    }
    for (const b of [...BUILTIN_FIXED_BUTTONS, ...layerButtons(layer, layerSlug(layer))]) {
      assert.ok(AUTOMATION_ACTIONS[b.action.id], `${b.base} action ${b.action.id} does not exist`);
      assert.ok(isValidCueName(b.base), `${b.base} is not a usable cue name`);
    }
  });

  test("the counts are exactly 4 switches, 3 buttons, and 3 per layer", () => {
    assert.equal(BUILTIN_FIXED_SWITCHES.length, 4);
    assert.equal(BUILTIN_FIXED_BUTTONS.length, 3);
    assert.equal(layerSwitches("Lyrics", "lyrics").length, 2);
    assert.equal(layerButtons("Lyrics", "lyrics").length, 1);

    LAYERS = ["Lyrics", "Lower Thirds"];
    const rules = builtinCueRules([]);
    // Two rules per switch, one per button. 4 + 2×2 switches = 8, and
    // 3 + 2×1 buttons = 5.
    assert.equal(rules.length, 8 * 2 + 5);
    assert.deepEqual(cueNames(rules).sort(), [
      "display_refresh",
      "obs_record_off",
      "obs_record_on",
      "obs_stream_off",
      "obs_stream_on",
      "obs_virtual_cam_off",
      "obs_virtual_cam_on",
      "pco_advance",
      "pvp_clear_workspace",
      "pvp_lower_thirds_clear",
      "pvp_lower_thirds_muted_off",
      "pvp_lower_thirds_muted_on",
      "pvp_lower_thirds_shown_off",
      "pvp_lower_thirds_shown_on",
      "pvp_lyrics_clear",
      "pvp_lyrics_muted_off",
      "pvp_lyrics_muted_on",
      "pvp_lyrics_shown_off",
      "pvp_lyrics_shown_on",
      "reaper_record_off",
      "reaper_record_on",
    ]);
  });

  test("a fixed switch binds exactly what its ON action implies", () => {
    for (const s of BUILTIN_FIXED_SWITCHES) {
      assert.deepEqual(
        s.binding,
        implicitStateBinding(s.on),
        `${s.base} does not bind what its ON action implies`,
      );
    }
  });

  test("the shown pair is the hidden family, inverted", () => {
    const [shown, muted] = layerSwitches("Lyrics", "lyrics");
    assert.deepEqual(shown!.binding, {
      variable: "app:pvp.layer-hidden:Lyrics",
      onValue: "off",
      offValue: "on",
    });
    assert.deepEqual(muted!.binding, {
      variable: "app:pvp.layer-muted:Lyrics",
      onValue: "on",
      offValue: "off",
    });
  });

  test("only the live switches carry a tone", () => {
    const live = BUILTIN_FIXED_SWITCHES.filter((s) => s.tone === "live").map((s) => s.base);
    assert.deepEqual(live, ["obs_record", "obs_stream", "reaper_record"]);
    assert.equal(builtinTone("obs_record"), "live");
    assert.equal(builtinTone("obs_virtual_cam"), undefined);
    assert.equal(builtinTone("haze"), undefined);
  });

  test("a built-in rule is a bound pair with no conditions", () => {
    ENABLED = new Set(["obs"]);
    CONNECTED = new Set();
    const rules = builtinCueRules([]);
    const pairs = cuePairs(rules);
    assert.deepEqual(pairs.map((p) => p.base), ["obs_record", "obs_stream", "obs_virtual_cam"]);
    assert.deepEqual(pairs[0]!.binding, {
      variable: "app:obs.recording",
      onValue: "on",
      offValue: "off",
    });
    for (const r of rules) {
      assert.deepEqual(r.conditions, [], `${r.id} carries a condition`);
      assert.ok(isBuiltinRule(r));
      assert.ok(r.id.startsWith(BUILTIN_ID_PREFIX));
      assert.equal(r.enabled, true);
    }
    // A switch half is idempotent through the call route, so it needs no
    // cooldown; a button has nothing to read and carries one.
    assert.equal(rules.find((r) => r.trigger.params.name === "obs_record_on")!.cooldownSec, 0);
  });

  test("a button carries a one second cooldown", () => {
    const refresh = builtinCueRules([]).find((r) => r.trigger.params.name === "display_refresh")!;
    assert.equal(refresh.cooldownSec, 1);
  });
});

describe("slugs", () => {
  test("a layer name becomes a usable cue name", () => {
    assert.equal(layerSlug("Lower Thirds"), "lower_thirds");
    assert.equal(layerSlug("Lyrics"), "lyrics");
    assert.equal(layerSlug("Lower Thirds / 2"), "lower_thirds_2");
    assert.equal(layerSlug("  Key  "), "key");
    assert.equal(layerSlug("!!!"), "");
  });

  test("a layer that cannot be named is skipped, and a duplicate slug is too", () => {
    LAYERS = ["!!!", "Lyrics", "lyrics"];
    const names = cueNames(builtinCueRules([])).filter((n) => n.startsWith("pvp_"));
    assert.deepEqual(names.sort(), [
      "pvp_clear_workspace",
      "pvp_lyrics_clear",
      "pvp_lyrics_muted_off",
      "pvp_lyrics_muted_on",
      "pvp_lyrics_shown_off",
      "pvp_lyrics_shown_on",
    ]);
  });
});

describe("gating", () => {
  test("a disabled integration offers nothing", () => {
    ENABLED = new Set();
    CONNECTED = new Set();
    LAYERS = ["Lyrics"];
    assert.deepEqual(cueNames(builtinCueRules([])), ["display_refresh"]);
  });

  test("Planning Center gates on connected, not enabled", () => {
    ENABLED = new Set(["planning-center"]);
    CONNECTED = new Set();
    assert.equal(cueNames(builtinCueRules([])).includes("pco_advance"), false);
    CONNECTED = new Set(["planning-center"]);
    assert.equal(cueNames(builtinCueRules([])).includes("pco_advance"), true);
  });

  test("PVP going offline keeps its layers listed", () => {
    LAYERS = ["Lyrics"];
    assert.ok(cueNames(builtinCueRules([])).includes("pvp_lyrics_shown_on"));
    // PVP publishes PVP_OFFLINE, whose layers are empty. Dropping the entities
    // here is what would make Home Assistant churn on every reconnect.
    LAYERS = [];
    assert.ok(cueNames(builtinCueRules([])).includes("pvp_lyrics_shown_on"));
    // Switching the integration off is the operator saying they are done.
    ENABLED = new Set(["obs"]);
    assert.equal(cueNames(builtinCueRules([])).some((n) => n.startsWith("pvp_lyrics")), false);
  });
});

describe("a stored rule owns its name", () => {
  test("the built-in with that base is not offered, and says so once", () => {
    ENABLED = new Set(["obs"]);
    CONNECTED = new Set();
    const rules = builtinCueRules([stored("obs_record_on", "REC on")]);
    assert.equal(cueNames(rules).includes("obs_record_on"), false);
    assert.equal(cueNames(rules).includes("obs_record_off"), false, "half a pair was offered");
    assert.ok(cueNames(rules).includes("obs_stream_on"), "the other switches went too");
    const said = [...LOG].filter((l) => l.includes("not offered"));
    assert.deepEqual(said, [
      '[cues] built-in obs_record not offered: rule "REC on" owns obs_record_on',
    ]);
    // Rebuilt on every manifest read; only a CHANGE is worth a line.
    LOG = [];
    builtinCueRules([stored("obs_record_on", "REC on")]);
    assert.deepEqual(LOG, []);
  });

  test("a former name owns it too", () => {
    ENABLED = new Set(["obs"]);
    CONNECTED = new Set();
    const rule = stored("rec_on", "REC on");
    rule.trigger.params.aliases = "obs_record_on";
    assert.equal(cueNames(builtinCueRules([rule])).includes("obs_record_on"), false);
  });

  test("the OFF half alone suppresses the pair", () => {
    ENABLED = new Set(["obs"]);
    CONNECTED = new Set();
    const rules = builtinCueRules([stored("obs_record_off", "REC off")]);
    assert.equal(cueNames(rules).includes("obs_record_on"), false);
  });
});

describe("the count line", () => {
  test("says the totals per integration, and only when they change", () => {
    LAYERS = ["Lyrics", "Lower Thirds"];
    builtinCueRules([]);
    assert.deepEqual(offeredLines(), [
      "[cues] 13 built-in cues offered (obs 3, reaper 1, pvp 7, app 2)",
    ]);
    LOG = [];
    builtinCueRules([]);
    assert.deepEqual(LOG, [], "an unchanged set said something");
    ENABLED = new Set(["reaper"]);
    CONNECTED = new Set();
    builtinCueRules([]);
    assert.deepEqual(offeredLines(), ["[cues] 2 built-in cues offered (reaper 1, app 1)"]);
  });
});

describe("reserved names", () => {
  test("cover both halves of every fixed switch and every fixed button", () => {
    const reserved = reservedCueNames();
    assert.equal(reserved.size, 4 * 2 + 3);
    assert.ok(reserved.has("obs_record_on"));
    assert.ok(reserved.has("obs_record_off"));
    assert.ok(reserved.has("display_refresh"));
    // A PVP layer name is the operator's own word. Reserving it would refuse a
    // rule that was legal yesterday because somebody renamed a layer.
    assert.equal(reserved.has("pvp_lyrics_shown_on"), false);
  });
});

describe("the set changing", () => {
  test("announces only when the inputs move", () => {
    builtinInputsChanged();
    assert.equal(CHANGED, 0, "the first call announced on a set that had not changed");
    builtinInputsChanged();
    assert.equal(CHANGED, 0);
    ENABLED = new Set(["obs", "reaper", "pvp", "youtube"]);
    builtinInputsChanged();
    assert.equal(CHANGED, 1);
    builtinInputsChanged();
    assert.equal(CHANGED, 1);
    LAYERS = ["Lyrics"];
    builtinInputsChanged();
    assert.equal(CHANGED, 2, "a PVP layer name change said nothing");
    LAYERS = ["Lyrics", "Key"];
    builtinInputsChanged();
    assert.equal(CHANGED, 3);
  });
});
