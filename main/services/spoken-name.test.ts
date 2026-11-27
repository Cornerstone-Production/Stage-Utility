// The name a person says for a cue is ONE function (spokenCueName). The pasted Home
// Assistant YAML and GET /api/cues (the integration) both read it, so the same
// rules give the same words whichever way Home Assistant was set up. They were two
// opposite fallbacks once: the YAML called a rule named "Foyer TVs" with no `says`
// "Foyer TVs", and the manifest called the same cue "Foyer Tvs".

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

describe("the same rules are called the same in the YAML and the manifest", () => {
  test("a single cue with no `says` is called by its rule's name, not its humanised cue name", async () => {
    RULES = [cue("Foyer TVs", "foyer_tvs")];
    const named = (await cueManifest()).buttons[0]?.name;
    assert.equal(named, "Foyer TVs");
    assert.equal(inYaml(homeAssistantYaml(RULES, "http://192.168.1.50:8788"), named), true);
  });

  test("a pair with no `says` is called by its ON rule's name, the trailing `on` taken off", async () => {
    RULES = [cue("Projectors on", "projectors_on"), cue("Projectors off", "projectors_off")];
    const named = (await cueManifest()).switches[0]?.name;
    assert.equal(named, "Projectors");
    assert.equal(inYaml(homeAssistantYaml(RULES, "http://192.168.1.50:8788"), named), true);
  });

  test("a single cue's `says` keeps its trailing `on`: only a switch has the verb supplied for it", async () => {
    RULES = [cue("Light the stage", "stage_lights", "Lights on")];
    const named = (await cueManifest()).buttons[0]?.name;
    assert.equal(named, "Lights on");
    assert.equal(inYaml(homeAssistantYaml(RULES, "http://192.168.1.50:8788"), named), true);
  });

  test("a rule with no name falls back to the cue name humanised, in both", async () => {
    RULES = [cue("  ", "main_conf_tvs")];
    const named = (await cueManifest()).buttons[0]?.name;
    assert.equal(named, "Main Conf Tvs");
    assert.equal(inYaml(homeAssistantYaml(RULES, "http://192.168.1.50:8788"), named), true);
  });
});
