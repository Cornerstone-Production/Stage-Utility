// cue-naming.ts: the name a Button's own command gets. The server names a migrated
// Button's command with it and the Button inspector names a new one, so it is tested
// here, beside the module, and not in either caller.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { Rule } from "../types/automation.js";
import { CALL_TRIGGER_ID } from "./cue-aliases.js";
import type { CueManifest } from "./cue-manifest.js";
import { deriveCueName } from "./cue-name.js";
import { BUTTON_CUE, namesTakenForNewCue as takenCueNames } from "./cue-naming.js";

const rule = (params: Record<string, string | number>, trigger: string = CALL_TRIGGER_ID): Rule => ({
  id: "r",
  name: "r",
  enabled: true,
  trigger: { id: trigger, params },
  conditions: [],
  action: { id: "log.message", params: {} },
  cooldownSec: 0,
  oncePerService: false,
});

describe("takenCueNames", () => {
  test("reads cue names and former names from the rules, and ignores other triggers", () => {
    const taken = takenCueNames(
      [rule({ name: "A_One", aliases: "old_a, older_a" }), rule({ name: "not_a_cue" }, "clock.at")],
      null,
    );
    assert.deepEqual([...taken].sort(), ["a_one", "old_a", "older_a"]);
  });
  test("a pair's base is taken as well as its halves, as the server counts it", () => {
    const taken = takenCueNames([rule({ name: "btn_x_on" }), rule({ name: "btn_x_off" })], null);
    assert.deepEqual([...taken].sort(), ["btn_x", "btn_x_off", "btn_x_on"]);
    assert.equal(deriveCueName("x", taken, BUTTON_CUE), "btn_x_2");
  });
  test("reads every id and call name from the manifest, which is where built-ins and pair bases are", () => {
    const manifest = {
      version: 1,
      server: { name: "t", lanUrl: null },
      switches: [{ id: "obs_record", on: "obs_record_on", off: "obs_record_off" }],
      buttons: [{ id: "display_refresh", cue: "display_refresh" }],
    } as unknown as CueManifest;
    assert.deepEqual(
      [...takenCueNames([], manifest)].sort(),
      ["display_refresh", "obs_record", "obs_record_off", "obs_record_on"],
    );
  });
});
