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
    // Quoted, like the switch keys: a script called `on` is a boolean key.
    const key = /^ {2}"(\w+)":$/.exec(lines[i]!);
    if (!key) continue;
    const alias = /^ {4}alias: "((?:[^"\\\n\r\t]|\\.)*)"$/.exec(lines[i + 1] ?? "");
    assert.ok(alias, `alias is not a single well-formed quoted scalar: ${JSON.stringify(lines[i + 1])}`);
    out.push({ name: key[1]!, alias: alias[1]! });
  }
  return out;
}

/** Every comment line, trimmed — the renamed-from notes live here. */
function comments(yaml: string): string[] {
  return yaml
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("#"));
}

/**
 * The `json_attributes` list under the rest sensor, in order, unquoted.
 *
 * The quotes are REQUIRED, and that is what this asserts. Home Assistant parses
 * YAML 1.1, where a bare `no`, `on`, `off`, `yes`, `true` or `false` is a
 * boolean — so a pair called `no_on`/`no_off` asked the sensor for the attribute
 * `false`, which no answer has ever contained.
 */
function sensorAttributes(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.indexOf("        json_attributes:");
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {10}- (.+)$/.exec(lines[i]!);
    if (!m) break;
    const quoted = /^"((?:[^"\\\n\r\t]|\\.)*)"$/.exec(m[1]!);
    assert.ok(quoted, `a json_attributes item is not a quoted scalar: ${JSON.stringify(m[1])}`);
    out.push(quoted[1]!);
  }
  return out;
}

/** Every switch key, with what it reports its state from. */
function switchStates(yaml: string): { id: string; from: string }[] {
  const lines = yaml.split("\n");
  const start = lines.indexOf("    switches:");
  if (start === -1) return [];
  const out: { id: string; from: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // The key is QUOTED, for the same YAML 1.1 reason as the attribute list: a
    // switch id of `no` is the boolean false as a mapping key.
    const key = /^ {6}"(\w+)":$/.exec(lines[i]!);
    if (!key) continue;
    const block = lines.slice(i + 1, i + 6).join("\n");
    const optimistic = / {8}optimistic: true/.test(block);
    const template = / {8}value_template: (.+)/.exec(block);
    out.push({
      id: key[1]!,
      // Both is a contradiction and neither is a switch with no state at all,
      // so the two are reported as one answer rather than two booleans.
      from: optimistic && template ? "BOTH" : optimistic ? "optimistic" : template ? template[1]! : "NEITHER",
    });
  }
  return out;
}

/** One called cue, with only the fields the generator reads set meaningfully. */
function cue(
  name: string,
  says: string,
  ruleName = name,
  aliases = "",
  state: Record<string, string> = {},
): Rule {
  return {
    id: `id-${name}`,
    name: ruleName,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name, says, aliases, ...state } },
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

  test("two scripts whose cues say the same thing get DIFFERENT aliases", () => {
    // The switches were disambiguated and the scripts were not, so two one-shot
    // cues with the same `says` put two scripts called "the screens" into Home
    // Assistant. An assistant asked to run "the screens" then picks one at
    // random, which is the same failure as two identical switches.
    const yaml = homeAssistantYaml(
      [cue("main_screens", "the screens"), cue("south_screens", "the screens")],
      BASE,
    );
    const aliases = scripts(yaml).map((x) => x.alias);
    assert.deepEqual(aliases, ["Main Screens", "South Screens"]);
    assert.equal(new Set(aliases).size, aliases.length, "two scripts share an alias");
  });

  test("a switch and a script that would say the same thing are separated too", () => {
    // Across the KINDS, which no amount of disambiguating each list on its own
    // would catch. To a voice assistant a switch's friendly_name and a script's
    // alias are one namespace: the words somebody says out loud.
    const yaml = homeAssistantYaml(
      [
        cue("projectors_on", "Projectors on"),
        cue("projectors_off", "Projectors off"),
        cue("take_screens", "Projectors"),
      ],
      BASE,
    );
    const said = [...friendlyNames(yaml), ...scripts(yaml).map((x) => x.alias)];
    assert.deepEqual(said, ["Projectors", "Take Screens"]);
    assert.equal(new Set(said).size, said.length, "a switch and a script share a spoken name");
  });

  test("a pair and a one-shot cue on the SAME base are separated by their domain", () => {
    // The one case humanising the id cannot separate: `switch.projectors` and
    // `script.projectors` are two different Home Assistant entities whose ids
    // humanise identically, so the domain goes into the words.
    const yaml = homeAssistantYaml(
      [
        cue("projectors_on", "Projectors on"),
        cue("projectors_off", "Projectors off"),
        cue("projectors", "Projectors"),
      ],
      BASE,
    );
    const said = [...friendlyNames(yaml), ...scripts(yaml).map((x) => x.alias)];
    assert.deepEqual(said, ["Projectors (switch)", "Projectors (script)"]);
    assert.equal(new Set(said).size, said.length, "a switch and a script share a spoken name");
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

  test("a renamed cue is called out in a comment, and its former name is NOT a command", () => {
    // The former name is a live URL by design — that is what keeps an already
    // pasted config working. Emitting it as a second `rest_command` would leave
    // Home Assistant with two names for one cue forever, so the comment is the
    // whole of it: it tells the operator to re-paste, and nothing more.
    const yaml = homeAssistantYaml(
      [cue("screens_on", "Screens on", "Screens ON", "projectors_on")],
      BASE,
    );
    assert.deepEqual(commandKeys(yaml), ["su_screens_on"]);
    assert.equal(
      yaml.includes("su_projectors_on:"),
      false,
      "a former name was emitted as a command of its own",
    );
    assert.ok(
      comments(yaml).includes(
        "# renamed from su_projectors_on; the old rest_command keeps working until you re-paste",
      ),
      `no renamed-from comment; got:\n  ${comments(yaml).join("\n  ")}`,
    );
  });

  test("two former names are named together, and the grammar follows", () => {
    const yaml = homeAssistantYaml(
      [cue("screens_on", "Screens on", "Screens ON", "projectors_on,beamers_on")],
      BASE,
    );
    assert.ok(
      comments(yaml).includes(
        "# renamed from su_projectors_on, su_beamers_on; the old rest_commands keep working " +
          "until you re-paste",
      ),
      `wrong wording for two former names; got:\n  ${comments(yaml).join("\n  ")}`,
    );
  });

  test("a cue that was never renamed gets no comment of its own", () => {
    // The header comments are always there; nothing about a rename is.
    const yaml = homeAssistantYaml([cue("screens_on", "Screens on")], BASE);
    assert.equal(comments(yaml).some((c) => c.includes("renamed from")), false);
  });
});

// ── Real state ────────────────────────────────────────────────────────────────
//
// A pair that names a Companion custom variable gets the truth instead of
// optimism. Two things here are silent when they go wrong and expensive when
// they do:
//
//  - a sensor whose `json_attributes` does not list a pair the switches read
//    from. The switch then reads an attribute that never appears, and reports
//    off forever with nothing in any log.
//  - a switch carrying `optimistic: true` AND a `value_template`. Optimistic
//    means "believe the press and do not wait for the state", which is exactly
//    what a state variable exists to replace, so a switch with both keeps
//    reporting what it asked for while looking as if it reads the device.
describe("a pair with a state variable", () => {
  const bound = (name: string, says: string, variable: string) =>
    cue(name, says, name, "", { stateVariable: variable });

  test("emits ONE rest sensor listing exactly the bound pairs", () => {
    const yaml = homeAssistantYaml(
      [
        bound("projectors_on", "Projectors on", "projectors_state"),
        cue("projectors_off", "Projectors off"),
        bound("amps_on", "Amps on", "amps_state"),
        cue("amps_off", "Amps off"),
        cue("lobby_tvs_on", "Lobby TVs on"),
        cue("lobby_tvs_off", "Lobby TVs off"),
      ],
      BASE,
    );
    assert.equal((yaml.match(/^rest:$/gm) ?? []).length, 1, "one sensor for every pair, not one each");
    assert.match(yaml, /^ {2}- resource: "http:\/\/192\.168\.1\.50:8788\/api\/cues\/states"$/m);
    assert.match(yaml, /^ {4}scan_interval: 10$/m);
    assert.match(yaml, /^ {8}json_attributes_path: "\$\.states"$/m);
    // EXACT, and in the order the switches are emitted in. `lobby_tvs` has no
    // variable, so it must not be here.
    assert.deepEqual(sensorAttributes(yaml), ["amps", "projectors"]);
  });

  test("the bound switch reads the sensor, and is NOT optimistic", () => {
    const yaml = homeAssistantYaml(
      [
        bound("projectors_on", "Projectors on", "projectors_state"),
        cue("projectors_off", "Projectors off"),
        cue("amps_on", "Amps on"),
        cue("amps_off", "Amps off"),
      ],
      BASE,
    );
    assert.deepEqual(switchStates(yaml), [
      { id: "amps", from: "optimistic" },
      {
        id: "projectors",
        from: "\"{{ (state_attr('sensor.stage_utility_cues', 'projectors') or {}).get('state') == 'on' }}\"",
      },
    ]);
    // Guarded as a count too: one `optimistic: true` in the document, for the
    // one pair that has nothing to read.
    assert.equal((yaml.match(/^ {8}optimistic: true$/gm) ?? []).length, 1);
  });

  test("nothing bound means no rest sensor at all", () => {
    // An install with no state variables must generate the document it always
    // did: a `rest` block with an empty attribute list is a sensor Home
    // Assistant polls every ten seconds for nothing.
    const yaml = homeAssistantYaml(
      [cue("projectors_on", "Projectors on"), cue("projectors_off", "Projectors off")],
      BASE,
    );
    assert.equal(yaml.includes("rest:\n"), false);
    assert.equal(yaml.includes("/api/cues/states"), false);
    assert.deepEqual(sensorAttributes(yaml), []);
    assert.deepEqual(switchStates(yaml), [{ id: "projectors", from: "optimistic" }]);
  });

  test("a binding on a cue with no partner emits no sensor and no switch", () => {
    // There is no pair, so there is nothing to report the state OF. The cue
    // still gets its rest_command and its script.
    const yaml = homeAssistantYaml([bound("house_lights_on", "House lights on", "hl_state")], BASE);
    assert.equal(yaml.includes("rest:\n"), false);
    assert.deepEqual(switchStates(yaml), []);
    assert.deepEqual(commandKeys(yaml), ["su_house_lights_on"]);
  });

  test("a HALF-RENAMED bound pair keeps its switch, under the pasted base", () => {
    // The ON button was relabelled and its cue renamed; the OFF button was not.
    // Matched on current names only this is not a pair at all: the switch
    // somebody already pasted disappears and turns into two scripts.
    const yaml = homeAssistantYaml(
      [
        cue("screens_on", "Screens on", "Screens ON", "projectors_on", {
          stateVariable: "projectors_state",
        }),
        cue("projectors_off", "Projectors off"),
      ],
      BASE,
    );
    assert.deepEqual(sensorAttributes(yaml), ["projectors"]);
    assert.deepEqual(
      switchStates(yaml).map((s) => s.id),
      ["projectors"],
    );
    assert.match(yaml, /^ {10}action: rest_command\.su_screens_on$/m);
    assert.deepEqual(scripts(yaml), [], "a half of a pair must never also be a script");
  });

  test("a base YAML 1.1 would read as a BOOLEAN is quoted everywhere", () => {
    // Home Assistant parses YAML 1.1. `no`, `on`, `off`, `yes`, `true` and
    // `false` bare are booleans there, so `- no` under json_attributes asked the
    // sensor for the attribute `false` — an attribute no answer has ever
    // carried, leaving the switch reading off forever with nothing in any log.
    // The same word is also the switch's own mapping key, and a one-shot cue
    // called `on` is a script's.
    const yaml = homeAssistantYaml(
      [
        bound("no_on", "No on", "no_state"),
        cue("no_off", "No off"),
        cue("on", "just on"),
      ],
      BASE,
    );
    // The helpers require a quoted scalar and fail on a bare one.
    assert.deepEqual(sensorAttributes(yaml), ["no"]);
    assert.deepEqual(switchStates(yaml).map((x) => x.id), ["no"]);
    assert.deepEqual(scripts(yaml).map((x) => x.name), ["on"]);
    // And the exact lines, so a passing helper cannot be a helper that matched
    // nothing.
    assert.match(yaml, /^ {10}- "no"$/m);
    assert.match(yaml, /^ {6}"no":$/m);
    assert.match(yaml, /^ {2}"on":$/m);
  });

  test("the sensor says what an unknown pair does, and why it is not unavailable", () => {
    // The one thing an operator cannot work out from the fragment: a pair that
    // could not be read reads OFF, which is indistinguishable from a device that
    // is off. Saying so beside the sensor is the only place it appears in Home
    // Assistant. The availability_template note is there so nobody adds the
    // obvious fix — an unavailable entity cannot be commanded, so it would also
    // stop them turning the device on.
    const yaml = homeAssistantYaml(
      [bound("p_on", "P on", "p_state"), cue("p_off", "P off")],
      BASE,
    );
    const said = comments(yaml);
    assert.ok(
      said.some((c) => c.includes("reads OFF here and stays PRESSABLE")),
      `nothing says what an unknown pair does; got:\n  ${said.join("\n  ")}`,
    );
    assert.ok(
      said.some((c) => c.includes("No availability_template on purpose")),
      `nothing says why the switch is not made unavailable; got:\n  ${said.join("\n  ")}`,
    );

    // And not in a document with nothing bound: there is no sensor to talk about.
    const without = homeAssistantYaml([cue("p_on", "P on"), cue("p_off", "P off")], BASE);
    assert.equal(comments(without).some((c) => c.includes("availability_template")), false);
  });

  test("the header says the switches read real state only when one does", () => {
    const withState = homeAssistantYaml(
      [bound("p_on", "P on", "p_state"), cue("p_off", "P off")],
      BASE,
    );
    assert.equal(
      comments(withState).some((c) => c.includes("actually doing")),
      true,
    );
    const without = homeAssistantYaml([cue("p_on", "P on"), cue("p_off", "P off")], BASE);
    assert.equal(
      comments(without).some((c) => c.includes("actually doing")),
      false,
    );
    assert.equal(
      comments(without).some((c) => c.includes("Switches are optimistic")),
      true,
    );
  });
});

// ── The whole unbound document, pinned ────────────────────────────────────────
//
// Everything else here reads one thing out of the fragment, so a change to the
// SHAPE of it — a key renamed, a comment dropped, a block reordered, an
// indentation off by two — passes every one of them while quietly rewriting what
// somebody has to re-paste into Home Assistant. This is the whole output for an
// install with no state bindings, which is what every existing install is.
//
// It is not here to be right, it is here to be DELIBERATE: when it fails, read
// the diff, decide whether the new output is what you meant, and only then
// regenerate.
describe("the document for an install with no bindings", () => {
  /** A pair, a one-shot cue, and a renamed one-shot — every object this emits. */
  const UNBOUND_FIXTURE = (): Rule[] => [
    cue("projectors_on", "Projectors on"),
    cue("projectors_off", "Projectors off"),
    cue("take_screens", "take the screens"),
    cue("screens_on", "Screens on", "Screens ON", "beamers_on"),
  ];

  const UNBOUND_YAML = [
  "# Stage Utility cues \u2014 generated. Paste into configuration.yaml.",
  "#",
  "# Put the token you were shown when you minted it into secrets.yaml, WITH",
  "# the scheme, because this is the whole Authorization header:",
  "#",
  "#   stage_utility_token: \"Bearer su_...\"",
  "#",
  "# Switches are optimistic: Stage Utility reports that it dispatched the",
  "# press, never that the device did anything. Home Assistant shows what it",
  "# asked for, not what happened.",
  "",
  "rest_command:",
  "  su_projectors_on:",
  "    url: \"http://192.168.1.50:8788/api/cues/projectors_on\"",
  "    method: post",
  "    headers:",
  "      authorization: !secret stage_utility_token",
  "    content_type: \"application/json\"",
  "    payload: \"{}\"",
  "  su_projectors_off:",
  "    url: \"http://192.168.1.50:8788/api/cues/projectors_off\"",
  "    method: post",
  "    headers:",
  "      authorization: !secret stage_utility_token",
  "    content_type: \"application/json\"",
  "    payload: \"{}\"",
  "  su_take_screens:",
  "    url: \"http://192.168.1.50:8788/api/cues/take_screens\"",
  "    method: post",
  "    headers:",
  "      authorization: !secret stage_utility_token",
  "    content_type: \"application/json\"",
  "    payload: \"{}\"",
  "  # renamed from su_beamers_on; the old rest_command keeps working until you re-paste",
  "  su_screens_on:",
  "    url: \"http://192.168.1.50:8788/api/cues/screens_on\"",
  "    method: post",
  "    headers:",
  "      authorization: !secret stage_utility_token",
  "    content_type: \"application/json\"",
  "    payload: \"{}\"",
  "",
  "switch:",
  "  - platform: template",
  "    switches:",
  "      \"projectors\":",
  "        friendly_name: \"Projectors\"",
  "        optimistic: true",
  "        turn_on:",
  "          action: rest_command.su_projectors_on",
  "        turn_off:",
  "          action: rest_command.su_projectors_off",
  "",
  "script:",
  "  \"take_screens\":",
  "    alias: \"take the screens\"",
  "    sequence:",
  "      - action: rest_command.su_take_screens",
  "  \"screens_on\":",
  "    alias: \"Screens on\"",
  "    sequence:",
  "      - action: rest_command.su_screens_on",
  "",
  ].join("\n");

  test("is exactly this, to the character", () => {
    const yaml = homeAssistantYaml(UNBOUND_FIXTURE(), BASE);
    // TO REGENERATE, once you have decided the change is intended:
    //   SU_PRINT_YAML=1 node --import tsx --test main/services/home-assistant-yaml.test.ts
    // and paste the printed lines over UNBOUND_YAML above.
    if (process.env.SU_PRINT_YAML) {
      console.log(yaml.split("\n").map((l) => `    ${JSON.stringify(l)},`).join("\n"));
    }
    assert.equal(yaml, UNBOUND_YAML);
  });

  test("and nothing in it mentions state", () => {
    // The cheap half of the same guard, said in one line: an unbound install must
    // not grow a sensor it polls every ten seconds for nothing.
    const yaml = homeAssistantYaml(UNBOUND_FIXTURE(), BASE);
    assert.equal(yaml.includes("rest:"), false);
    assert.equal(yaml.includes("state_attr"), false);
  });
});
