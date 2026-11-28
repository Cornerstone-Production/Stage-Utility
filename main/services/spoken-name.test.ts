// The name a person says for a cue, as GET /api/cues (the Home Assistant
// integration) answers it, through spokenCueName. The pasted YAML keeps the naming
// it shipped with instead (`says`, else the rule's name, else the cue name), because
// regenerating it must not rename entities an operator already has; its names are
// pinned in home-assistant-yaml.test.ts. Where the two agree is asserted here.

import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, test } from "node:test";

// stage-controller resolves the data directory at import.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "spoken-name-"));

const { cueManifest, cueManifestDeps } = await import("./cue-manifest.js");
const { homeAssistantYaml } = await import("./home-assistant-yaml.js");
const { CALL_TRIGGER_ID } = await import("./cue-aliases.js");
type Rule = import("../types/automation.js").Rule;

function cue(ruleName: string, cueName: string, says?: string): Rule {
  return {
    id: cueName,
    name: ruleName,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name: cueName, ...(says === undefined ? {} : { says }) } },
    conditions: [],
    action: { id: "log.message", params: {} },
    cooldownSec: 0,
    oncePerService: false,
  };
}

let RULES: Rule[] = [];
beforeEach(() => {
  RULES = [];
  cueManifestDeps.rules = async () => RULES;
  cueManifestDeps.states = async () => ({ ok: true, checkedAt: "2026-09-09T14:00:00.000Z", states: new Map() });
});

/** The words the YAML gives a cue, found by the words themselves: a script's alias or a switch's name. */
function inYaml(yaml: string, words: string): boolean {
  return yaml.includes(`    alias: "${words}"\n`) || yaml.includes(`      - name: "${words}"\n`);
}

const yamlOf = () => homeAssistantYaml(RULES, "http://192.168.1.50:8788");

describe("what the manifest calls a cue", () => {
  test("a single cue with no `says` is its cue name humanised, whatever its rule is called", async () => {
    RULES = [cue("Foyer TVs", "foyer_tvs")];
    assert.equal((await cueManifest()).buttons[0]?.name, "Foyer Tvs");
  });

  test("a pair with no `says` is its base humanised", async () => {
    RULES = [cue("Turn the projectors on", "projectors_on"), cue("Turn the projectors off", "projectors_off")];
    assert.equal((await cueManifest()).switches[0]?.name, "Projectors");
  });

  test("a trailing `on` is taken off `says` for a single command too", async () => {
    RULES = [cue("Light the stage", "stage_lights", "Lights on")];
    assert.equal((await cueManifest()).buttons[0]?.name, "Lights");
  });

  test("`says` wins, in the YAML too", async () => {
    RULES = [cue("Foyer TVs", "foyer_tvs", "the foyer screens")];
    const named = (await cueManifest()).buttons[0]?.name;
    assert.equal(named, "the foyer screens");
    assert.equal(inYaml(yamlOf(), named), true);
  });
});

describe("two cues with the same words are told apart the same way in both", () => {
  test("cues with one `says` get different names in the manifest, and the YAML holds the same ones", async () => {
    RULES = [cue("A", "press_button", "Press a button"), cue("B", "press_button_2", "Press a button")];
    const names = (await cueManifest()).buttons.map((b) => b.name);
    assert.equal(new Set(names).size, 2, names.join(" | "));
    for (const n of names) assert.equal(inYaml(yamlOf(), n), true, n);
  });
});

describe("a switch and a button of one name", () => {
  test("keep it in the manifest: the two kinds are not compared", async () => {
    RULES = [cue("", "projectors_on"), cue("", "projectors_off"), cue("", "projectors")];
    const m = await cueManifest();
    assert.deepEqual(
      [m.switches.map((s) => s.name), m.buttons.map((b) => b.name)],
      [["Projectors"], ["Projectors"]],
    );
  });
});
