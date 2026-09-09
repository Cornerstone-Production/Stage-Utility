// The generated Home Assistant fragment.
//
// Pure text in, pure text out, and two of these guard failures that are silent
// at the point they happen and loud an hour later in somebody else's system:
//
//  - a `says` with a line break in it. A literal newline cannot appear inside a
//    double-quoted YAML scalar, so Home Assistant rejects the WHOLE document and
//    every cue disappears, not just the one with the bad name.
//  - two switches with the same `friendly_name`. Home Assistant takes both, the
//    operator says "turn on the projectors", and which room answers is a coin
//    toss found out during a service.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { homeAssistantYaml } from "./home-assistant-yaml.js";
import { CALL_TRIGGER_ID } from "./automation-triggers.js";
import type { Rule } from "../types/automation.js";

const BASE = "http://192.168.1.50:8788";

/**
 * The `friendly_name` of every generated switch, in order.
 *
 * There is no YAML parser in this project's dependency tree and one is not worth
 * adding for a test, so the line is matched as YAML defines a double-quoted
 * scalar: opening quote, escaped content, closing quote, all on ONE line. That is
 * what makes this a real check of the escaping — a raw newline in the value ends
 * the line without a closing quote and matches nothing, exactly as it would break
 * a real parse.
 */
const QUOTED = /^ {8}friendly_name: "((?:[^"\\\n\r\t]|\\.)*)"$/;

function friendlyNames(yaml: string): string[] {
  const declared = yaml.split("\n").filter((l) => l.trimStart().startsWith("friendly_name:"));
  const parsed: string[] = [];
  for (const line of declared) {
    const m = QUOTED.exec(line);
    assert.ok(m, `friendly_name is not a single well-formed quoted scalar: ${JSON.stringify(line)}`);
    parsed.push(m[1]!.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return parsed;
}

/** The `rest_command` keys, in order. */
function commandKeys(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}(su_\w+):$/gm)].map((m) => m[1]!);
}

/**
 * The `script:` keys and their aliases, in order.
 *
 * Read off the block rather than by matching `^ {2}\w+:$` anywhere, because the
 * `rest_command` keys sit at the same indent and a scan that could not tell them
 * apart would report every cue as having a script.
 */
function scripts(yaml: string): { name: string; alias: string }[] {
  const lines = yaml.split("\n");
  const start = lines.indexOf("script:");
  if (start === -1) return [];
  const out: { name: string; alias: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const key = /^ {2}(\w+):$/.exec(lines[i]!);
    if (!key) continue;
    const alias = /^ {4}alias: "((?:[^"\\\n\r\t]|\\.)*)"$/.exec(lines[i + 1] ?? "");
    assert.ok(alias, `alias is not a single well-formed quoted scalar: ${JSON.stringify(lines[i + 1])}`);
    out.push({ name: key[1]!, alias: alias[1]! });
  }
  return out;
}

/** One called cue, with only the fields the generator reads set meaningfully. */
function cue(name: string, says: string, ruleName = name): Rule {
  return {
    id: `id-${name}`,
    name: ruleName,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name, says } },
    conditions: [],
    action: { id: "log.message", params: { message: "x" } },
    cooldownSec: 0,
    oncePerService: false,
  };
}

describe("homeAssistantYaml", () => {
  test("one rest_command per cue and one switch per ON/OFF pair", () => {
    const yaml = homeAssistantYaml(
      [cue("projectors_on", "Projectors on"), cue("projectors_off", "Projectors off")],
      BASE,
    );
    assert.deepEqual(commandKeys(yaml), ["su_projectors_on", "su_projectors_off"]);
    assert.match(yaml, /url: "http:\/\/192\.168\.1\.50:8788\/api\/cues\/projectors_on"/);
    // The switch is the THING; Home Assistant supplies the verb.
    assert.deepEqual(friendlyNames(yaml), ["Projectors"]);
    assert.equal((yaml.match(/^ {8}optimistic: true$/gm) ?? []).length, 1);
  });

  test("a newline in `says` does not break the document", () => {
    const yaml = homeAssistantYaml(
      [cue("lobby_tvs_on", "Lobby:\nTVs on"), cue("lobby_tvs_off", "Lobby:\nTVs off")],
      BASE,
    );
    // A raw line break here ends the line with the quote unclosed, which is what
    // makes Home Assistant reject the whole file — friendlyNames refuses it.
    assert.deepEqual(friendlyNames(yaml), ["Lobby:\nTVs"]);
    assert.match(yaml, /friendly_name: "Lobby:\\nTVs"/);
    assert.equal(yaml.includes('friendly_name: "Lobby:\n'), false, "a raw newline is inside the quotes");
  });

  test("a tab and a carriage return survive the same way", () => {
    const yaml = homeAssistantYaml([cue("a_on", "A\tB\rC on"), cue("a_off", "A\tB\rC off")], BASE);
    assert.deepEqual(friendlyNames(yaml), ["A\tB\rC"]);
  });

  test("a quote and a backslash are escaped, not doubled up", () => {
    const yaml = homeAssistantYaml(
      [cue('q_on', 'The "back\\slash" room on'), cue("q_off", 'The "back\\slash" room off')],
      BASE,
    );
    assert.deepEqual(friendlyNames(yaml), ['The "back\\slash" room']);
  });

  test("two pairs that would share a friendly_name are separated by their cue name", () => {
    // Hand-written cues have no page to name them after — the Companion import
    // does that on the way in — so the cue name, which the engine already
    // guarantees is unique, is what separates them. Two identical switches in
    // Home Assistant is an operator saying "turn on the projectors" and a coin
    // toss deciding which room answers.
    const yaml = homeAssistantYaml(
      [
        cue("ma_projectors_on", "Projectors on"),
        cue("ma_projectors_off", "Projectors off"),
        cue("sa_projectors_on", "Projectors on"),
        cue("sa_projectors_off", "Projectors off"),
      ],
      BASE,
    );
    const names = friendlyNames(yaml);
    assert.deepEqual(names, ["Ma Projectors", "Sa Projectors"]);
    assert.equal(new Set(names).size, names.length, "two switches share a name");
  });

  test("distinct friendly names are left alone", () => {
    const yaml = homeAssistantYaml(
      [
        cue("ma_projectors_on", "Main projectors on"),
        cue("ma_projectors_off", "Main projectors off"),
        cue("sa_projectors_on", "South projectors on"),
        cue("sa_projectors_off", "South projectors off"),
      ],
      BASE,
    );
    assert.deepEqual(friendlyNames(yaml), ["Main projectors", "South projectors"]);
  });

  test("a cue with no partner still gets its rest_command, and no switch", () => {
    const yaml = homeAssistantYaml([cue("house_lights_on", "House lights on")], BASE);
    assert.deepEqual(commandKeys(yaml), ["su_house_lights_on"]);
    assert.deepEqual(friendlyNames(yaml), []);
  });

  test("a cue that is not half of a pair gets a script, aliased from `says`", () => {
    const yaml = homeAssistantYaml([cue("take_screens", "take the screens")], BASE);
    assert.deepEqual(scripts(yaml), [{ name: "take_screens", alias: "take the screens" }]);
    assert.match(yaml, /^ {6}- action: rest_command\.su_take_screens$/m);
    // No switch: a one-shot button has no on and no off, and a switch for it
    // would sit in Home Assistant claiming a state it never had.
    assert.deepEqual(friendlyNames(yaml), []);
  });

  test("a pair is a switch and NEITHER half is also a script", () => {
    // Both objects for one cue is two things in Home Assistant fighting over
    // one Companion button.
    const yaml = homeAssistantYaml(
      [cue("projectors_on", "Projectors on"), cue("projectors_off", "Projectors off")],
      BASE,
    );
    assert.deepEqual(friendlyNames(yaml), ["Projectors"]);
    assert.deepEqual(scripts(yaml), []);
  });

  test("an `_on` with no partner is not a pair, so it is a script", () => {
    // The rule for what a pair IS lives in one place; this is the boundary of it.
    const yaml = homeAssistantYaml([cue("house_lights_on", "House lights on")], BASE);
    assert.deepEqual(scripts(yaml), [{ name: "house_lights_on", alias: "House lights on" }]);
    assert.deepEqual(friendlyNames(yaml), []);
  });

  test("a pair and a single in one document each get their own object, and only that", () => {
    const yaml = homeAssistantYaml(
      [
        cue("projectors_on", "Projectors on"),
        cue("projectors_off", "Projectors off"),
        cue("take_screens", "take the screens"),
      ],
      BASE,
    );
    assert.deepEqual(commandKeys(yaml), ["su_projectors_on", "su_projectors_off", "su_take_screens"]);
    assert.deepEqual(friendlyNames(yaml), ["Projectors"]);
    assert.deepEqual(
      scripts(yaml).map((x) => x.name),
      ["take_screens"],
    );
  });

  test("a newline in a script's alias does not break the document either", () => {
    // The same failure as a switch's friendly_name: one bad scalar and Home
    // Assistant rejects the WHOLE file, so every cue disappears.
    const yaml = homeAssistantYaml([cue("odd", "Take:\nScreens")], BASE);
    assert.deepEqual(scripts(yaml), [{ name: "odd", alias: "Take:\\nScreens" }]);
  });

  test("no cues yields a comment, not a half-written document", () => {
    const yaml = homeAssistantYaml([], BASE);
    assert.match(yaml, /No cues yet/);
    assert.deepEqual(commandKeys(yaml), []);
  });
});
