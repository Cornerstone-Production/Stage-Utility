// The naming half of "Make it a cue". The write itself, and the fields of the rule
// it makes, are driven through the real inspector in button-inspector.test.tsx.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { CALL_TRIGGER_ID } from "@main/services/cue-aliases.js";
import { cueNameFor, cueSlug, takenCueNames } from "./make-it-a-cue.js";
import type { CueManifest } from "@main/services/cue-manifest.js";
import type { Rule } from "@main/types/automation.js";

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

describe("cueSlug", () => {
  test("is lower_snake_case, with accents folded and no underscore at either end", () => {
    assert.equal(cueSlug("Projectors on"), "projectors_on");
    assert.equal(cueSlug("  Café -- Lights!  "), "cafe_lights");
    assert.equal(cueSlug("Stage 2 (left)"), "stage_2_left");
  });
  test("is empty when nothing usable is left", () => {
    assert.equal(cueSlug("!!!"), "");
    assert.equal(cueSlug(""), "");
  });
});

describe("cueNameFor", () => {
  test("a free name is used as it is", () => {
    assert.equal(cueNameFor("Walk now", new Set()), "walk_now");
  });
  test("a taken name gets the next free number", () => {
    assert.equal(cueNameFor("Walk now", new Set(["walk_now"])), "walk_now_2");
    assert.equal(cueNameFor("Walk now", new Set(["walk_now", "walk_now_2"])), "walk_now_3");
  });
  test("an on or off ending is not left as half of a pair", () => {
    assert.equal(cueNameFor("Projectors on", new Set()), "projectors_on_cue");
    assert.equal(cueNameFor("Haze off", new Set(["haze_off_cue"])), "haze_off_cue_2");
  });
  test("a label with no usable characters still gets a name", () => {
    assert.equal(cueNameFor("!!!", new Set()), "button");
    assert.equal(cueNameFor("!!!", new Set(["button"])), "button_2");
  });
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
    assert.equal(cueNameFor("x", taken, "btn_"), "btn_x_2");
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
