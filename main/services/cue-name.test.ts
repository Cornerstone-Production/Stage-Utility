// A cue name from a display name — and what it must never produce.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { deriveCueName, MAX_CUE_NAME } from "./cue-name.js";
import { isValidCueName } from "./automation-triggers.js";
import { isPairHalfName } from "./cue-pairs.js";
import { reservedCueNames } from "./builtin-cues.js";

const none: string[] = [];

describe("deriveCueName", () => {
  test("lower_snake_case from the words", () => {
    assert.equal(deriveCueName("Foyer TVs off!", none), "foyer_tvs_off_cue");
    assert.equal(deriveCueName("Reset the stage", none), "reset_the_stage");
    assert.equal(deriveCueName("  Lobby   lights / dim  ", none), "lobby_lights_dim");
  });

  test("never ends _on or _off, which the manifest would read as half of a pair", () => {
    assert.equal(deriveCueName("Projectors on", none), "projectors_on_cue");
    assert.equal(deriveCueName("Projectors OFF", none), "projectors_off_cue");
    assert.equal(isPairHalfName(deriveCueName("Projectors on", none)), false);
    // A name that merely contains on or off is not that shape.
    assert.equal(deriveCueName("On air light", none), "on_air_light");
  });

  test("a taken name gets a number, and a name or a former name are the same thing", () => {
    assert.equal(deriveCueName("Reset the stage", ["reset_the_stage"]), "reset_the_stage_2");
    assert.equal(deriveCueName("Reset the stage", ["reset_the_stage", "reset_the_stage_2"]), "reset_the_stage_3");
    // `taken` is a flat set of names and former names: the caller unions them.
    assert.equal(deriveCueName("Stage reset", ["stage_reset"]), "stage_reset_2");
  });

  test("a built-in's name is taken, so a cue made here never collides with one", () => {
    const taken = reservedCueNames();
    for (const name of ["display_refresh", "pco_advance", "pvp_clear_workspace"]) {
      assert.ok(taken.has(name), `${name} is not reserved: the fixture is stale`);
    }
    assert.equal(deriveCueName("Display refresh", taken), "display_refresh_2");
    assert.equal(deriveCueName("PCO advance", taken), "pco_advance_2");
  });

  test("words with no letters or digits are called cue", () => {
    assert.equal(deriveCueName("!!!", none), "cue");
    assert.equal(deriveCueName("", none), "cue");
    assert.equal(deriveCueName("!!!", ["cue"]), "cue_2");
  });

  test("a long sentence is cut, and what it makes is still a usable name", () => {
    const name = deriveCueName("a ".repeat(80), none);
    assert.ok(name.length <= MAX_CUE_NAME, `${name.length} characters`);
    assert.equal(isValidCueName(name), true, `"${name}" is not a usable cue name`);
  });

  test("the cap is hard: an _on that lands on the cut, and a clash after it, stay under it", () => {
    // 57 letters then "_on" is exactly 60 characters: the cut a 60 cap would make.
    const text = "a".repeat(57) + " on tail";
    for (const taken of [[], [deriveCueName(text, [])], [deriveCueName(text, []), deriveCueName(text, [deriveCueName(text, [])])]]) {
      const name = deriveCueName(text, taken);
      assert.ok(name.length <= MAX_CUE_NAME, `${name.length} characters: ${name}`);
      assert.equal(isPairHalfName(name), false, name);
    }
  });

  test("everything it makes is a name the server accepts", () => {
    for (const text of ["Projectors on", "Foyer TVs off!", "!!!", "x".repeat(200), "Café / Lobby", "A_B  C", "___", "2 pm"]) {
      const name = deriveCueName(text, none);
      assert.equal(isValidCueName(name), true, `"${text}" made "${name}"`);
      assert.equal(isPairHalfName(name), false, `"${text}" made "${name}", which reads as half of a pair`);
    }
  });
});
