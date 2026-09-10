// The generated Home Assistant fragment.
//
// Pure text in, pure text out, and two of these guard failures that are silent
// at the point they happen and loud an hour later in somebody else's system:
//
//  - a `says` with a line break in it. A literal newline cannot appear inside a
//    double-quoted YAML scalar, so Home Assistant rejects the WHOLE document and
//    every cue disappears, not just the one with the bad name.
//  - two switches with the same spoken `name`. Home Assistant takes both, the
//    operator says "turn on the projectors", and which room answers is a coin
//    toss found out during a service.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { homeAssistantYaml } from "./home-assistant-yaml.js";
import { CALL_TRIGGER_ID } from "./automation-triggers.js";
import type { Rule } from "../types/automation.js";

const BASE = "http://192.168.1.50:8788";

/**
 * The lines of the ONE `template:` block, or [] when there is none.
 *
 * Everything about the switches is read off this rather than off the whole
 * document, because `- name:` at six spaces is ALSO how the `rest` sensor names
 * itself: a scan of the raw text found that sensor and called it a switch.
 *
 * Asserts there is exactly one `template:` key while it is here. Two of them in
 * one file is a duplicate mapping key — YAML keeps the last, so half the
 * switches would silently not exist in Home Assistant.
 */
function templateBlock(yaml: string): string[] {
  const lines = yaml.split("\n");
  const starts = lines.flatMap((l, i) => (l === "template:" ? [i] : []));
  assert.ok(starts.length <= 1, `${starts.length} top-level template: keys; a second one is a duplicate`);
  if (starts.length === 0) return [];
  const out: string[] = [];
  for (let i = starts[0]! + 1; i < lines.length; i++) {
    // A top-level key or a blank line ends the block; everything inside it is
    // indented.
    if (lines[i] === "" || /^\S/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  assert.equal(out[0], "  - switch:", `template: does not open with one switch list; got ${JSON.stringify(out[0])}`);
  return out;
}

/**
 * The spoken `name` of every generated template switch, in order.
 *
 * There is no YAML parser in this project's dependency tree and one is not worth
 * adding for a test, so the line is matched as YAML defines a double-quoted
 * scalar: opening quote, escaped content, closing quote, all on ONE line. That is
 * what makes this a real check of the escaping — a raw newline in the value ends
 * the line without a closing quote and matches nothing, exactly as it would break
 * a real parse.
 */
const QUOTED = /^ {6}- name: "((?:[^"\\\n\r\t]|\\.)*)"$/;

function friendlyNames(yaml: string): string[] {
  const declared = templateBlock(yaml).filter((l) => l.trimStart().startsWith("- name:"));
  const parsed: string[] = [];
  for (const line of declared) {
    const m = QUOTED.exec(line);
    assert.ok(m, `switch name is not a single well-formed quoted scalar: ${JSON.stringify(line)}`);
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

/** Every switch's unique_id, with what it reports its state from. */
function switchStates(yaml: string): { id: string; from: string }[] {
  const lines = templateBlock(yaml);
  const out: { id: string; from: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {6}- name: /.test(lines[i]!)) continue;
    // The id is QUOTED, for the same YAML 1.1 reason as the attribute list: a
    // bare `no` or `on` is a boolean there. It is prefixed too, so quoting it is
    // belt and braces rather than the only thing holding it up.
    const id = /^ {8}unique_id: "stage_utility_(\w+)"$/.exec(lines[i + 1] ?? "");
    assert.ok(id, `switch has no quoted, prefixed unique_id: ${JSON.stringify(lines[i + 1])}`);
    const block = lines.slice(i + 2, i + 8).join("\n");
    const optimistic = /^ {8}optimistic: true$/m.test(block);
    const template = /^ {8}state: (.+)$/m.exec(block);
    out.push({
      id: id[1]!,
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
    assert.match(yaml, /- name: "Lobby:\\nTVs"/);
    assert.equal(yaml.includes('- name: "Lobby:\n'), false, "a raw newline is inside the quotes");
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

  test("two pairs that would share a spoken name are separated by their cue name", () => {
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
    // would catch. To a voice assistant a switch's spoken name and a script's
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
    // The same failure as a switch's name: one bad scalar and Home
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
//  - a switch carrying `optimistic: true` AND a `state` template. Optimistic
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
    // The same word is inside the switch's own `unique_id` — prefixed, so it
    // cannot be a bare boolean there — and a one-shot cue called `on` is a
    // script's mapping key, where it still can be.
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
    assert.match(yaml, /^ {8}unique_id: "stage_utility_no"$/m);
    assert.match(yaml, /^ {2}"on":$/m);
  });

  test("the sensor says what an unknown pair does, and why it is not unavailable", () => {
    // The one thing an operator cannot work out from the fragment: a pair that
    // could not be read reads OFF, which is indistinguishable from a device that
    // is off. Saying so beside the sensor is the only place it appears in Home
    // Assistant. The availability note is there so nobody adds the
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
      said.some((c) => c.includes("No availability template on purpose")),
      `nothing says why the switch is not made unavailable; got:\n  ${said.join("\n  ")}`,
    );

    // And not in a document with nothing bound: there is no sensor to talk about.
    const without = homeAssistantYaml([cue("p_on", "P on"), cue("p_off", "P off")], BASE);
    assert.equal(comments(without).some((c) => c.includes("availability template")), false);
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

// ── The template integration's modern shape ──────────────────────────
//
// This generated the LEGACY spelling — `switch:` with `- platform: template` and
// a `switches:` map under it — and current Home Assistant refuses it outright:
//
//   Unsupported YAML configuration for the template integration: configuring the
//   template integration by adding `platform: template` under the `switch:` key
//   is not supported. The template integration must be configured under its own
//   `template:` key instead.
//
// Every switch in a pasted fragment was gone, and the fragment itself parsed
// fine — so nothing in this file caught it. These are the four things that make
// it the modern shape, checked over every kind of document the generator emits.
describe("the template integration's modern shape", () => {
  const bound = (name: string, says: string, variable: string) =>
    cue(name, says, name, "", { stateVariable: variable });

  /** Every kind of document this can produce, named for the failure message. */
  const DOCUMENTS: Record<string, Rule[]> = {
    "no cues": [],
    "one unbound pair": [cue("projectors_on", "Projectors on"), cue("projectors_off", "Projectors off")],
    "one bound pair": [bound("projectors_on", "Projectors on", "projectors_state"), cue("projectors_off", "Projectors off")],
    "scripts only": [cue("take_screens", "take the screens")],
    "three pairs, one bound, plus a script": [
      bound("projectors_on", "Projectors on", "projectors_state"),
      cue("projectors_off", "Projectors off"),
      cue("amps_on", "Amps on"),
      cue("amps_off", "Amps off"),
      cue("lobby_tvs_on", "Lobby TVs on"),
      cue("lobby_tvs_off", "Lobby TVs off"),
      cue("take_screens", "take the screens"),
    ],
  };

  test("no `platform: template` in ANY document", () => {
    // The exact bug. Read off the CODE, not the raw text: the fragment names the
    // legacy spelling in a comment so an operator re-pasting knows why, and a
    // scan of the raw text called that comment the bug. Dropping whole-line
    // comments is safe here and nothing else is dropped — this generator never
    // writes a trailing comment after a value, which the second assertion pins.
    for (const [what, rules] of Object.entries(DOCUMENTS)) {
      const yaml = homeAssistantYaml(rules, BASE);
      const lines = yaml.split("\n");
      const code = lines.filter((l) => !l.trimStart().startsWith("#"));
      // A filter that ate the document would pass everything below it.
      assert.equal(
        code.some((l) => l.trim() !== ""),
        rules.length > 0,
        `${what}: dropping comments left nothing to check`,
      );
      const text = code.join("\n");
      assert.equal(
        /platform:\s*template/.test(text),
        false,
        `${what}: Home Assistant refuses \`platform: template\` under \`switch:\``,
      );
      // And no legacy `switch:` block of any kind, which is the only place it
      // could have gone. These three cannot appear in prose, so they are checked
      // against the whole document.
      assert.equal(/^switch:$/m.test(yaml), false, `${what}: a top-level switch: key`);
      assert.equal(/^ {4}switches:$/m.test(yaml), false, `${what}: a legacy switches: map`);
      assert.equal(/^\s*friendly_name:/m.test(yaml), false, `${what}: friendly_name is the legacy key`);
    }
  });

  test("ONE top-level `template:` key, with every switch in the list under it", () => {
    // A second top-level `template:` is a duplicate mapping key in one file:
    // YAML keeps the last, so the pairs before it would silently not exist.
    const yaml = homeAssistantYaml(DOCUMENTS["three pairs, one bound, plus a script"]!, BASE);
    assert.equal((yaml.match(/^template:$/gm) ?? []).length, 1);
    // One `- switch:` under it, not one per pair.
    assert.equal((yaml.match(/^ {2}- switch:$/gm) ?? []).length, 1);
    assert.deepEqual(
      switchStates(yaml).map((x) => x.id),
      ["amps", "lobby_tvs", "projectors"],
    );
    // The other three top-level keys are single too, for the same reason.
    for (const key of ["rest_command:", "rest:", "script:"]) {
      assert.equal(
        (yaml.match(new RegExp(`^${key}$`, "gm")) ?? []).length,
        1,
        `${key} is not a single top-level key`,
      );
    }
  });

  test("a bound switch carries `state:` and NOT `optimistic:`", () => {
    // Optimistic means "believe the press and do not wait for the state", which
    // is exactly what a state variable exists to replace.
    const yaml = homeAssistantYaml(DOCUMENTS["one bound pair"]!, BASE);
    const block = templateBlock(yaml).join("\n");
    assert.match(block, /^ {8}state: "\{\{ \(state_attr\('sensor\.stage_utility_cues', 'projectors'\)/m);
    assert.equal(/optimistic:/.test(block), false, "a bound switch is optimistic as well as read");
  });

  test("an unbound switch carries NO `state:` at all", () => {
    // Which is what makes it optimistic per the docs — the switch assumes its
    // commands succeeded. `optimistic: true` is spelled out beside it anyway.
    const yaml = homeAssistantYaml(DOCUMENTS["one unbound pair"]!, BASE);
    const block = templateBlock(yaml).join("\n");
    assert.equal(/^ {8}state:/m.test(block), false, "an unbound switch has a state template");
    assert.match(block, /^ {8}optimistic: true$/m);
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
  "# Template switches, under the template integration's own key. Home",
  "# Assistant refuses `platform: template` under `switch:` \u2014 the spelling",
  "# these used to be generated in \u2014 so re-paste this over an older copy.",
  "# Each entity id now follows the switch's name rather than the cue's, so an",
  "# automation of your own naming an old `switch.\u2026` may need its id updating.",
  "template:",
  "  - switch:",
  "      - name: \"Projectors\"",
  "        unique_id: \"stage_utility_projectors\"",
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

// ── A toggle pair: both halves press one button ───────────────────────────────

describe("a pair whose two halves press the SAME button", () => {
  /** A cue that presses a real coordinate, which is what makes a toggle one. */
  const press = (
    name: string,
    says: string,
    at: { page: number; row: number; col: number },
    state: Record<string, string> = {},
  ): Rule => ({
    ...cue(name, says, name, "", state),
    action: { id: "companion.press", params: { ...at } },
  });

  const SAME = { page: 1, row: 2, col: 1 };
  const OTHER = { page: 1, row: 2, col: 2 };

  /** Generate, and collect the `[cues]` warnings it wrote. */
  function generate(rules: Rule[]): { yaml: string; warnings: string[] } {
    const warnings: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      return { yaml: homeAssistantYaml(rules, BASE), warnings };
    } finally {
      console.warn = real;
    }
  }

  test("a BOUND toggle pair is an ordinary state switch, with the comment that says why", () => {
    const { yaml, warnings } = generate([
      press("house_lights_on", "House lights on", SAME, { stateVariable: "house_lights_state" }),
      press("house_lights_off", "House lights off", SAME),
    ]);
    assert.equal(
      comments(yaml).includes(
        "# toggle button: both directions press the same Companion button, so the state variable is what tells them apart",
      ),
      true,
    );
    assert.deepEqual(switchStates(yaml), [
      {
        id: "house_lights",
        from:
          "\"{{ (state_attr('sensor.stage_utility_cues', 'house_lights') or {}).get('state') == 'on' }}\"",
      },
    ]);
    assert.deepEqual(warnings, [], "a bound toggle is not a warning — it is the supported shape");
  });

  test("an UNBOUND one is emitted anyway, with a WARNING comment and one log line", () => {
    // The import cannot make this — a single button with no variable stays a
    // single cue — so it is two rules somebody wrote by hand, pointed at one
    // key. Dropping it would be a switch that vanished from Home Assistant with
    // nothing saying why; it is emitted, and it says what is wrong with it.
    const { yaml, warnings } = generate([
      press("house_lights_on", "House lights on", SAME),
      press("house_lights_off", "House lights off", SAME),
    ]);
    assert.equal(
      comments(yaml).includes(
        "# WARNING: both halves press the same button and no state variable is bound — Home cannot know which way it went",
      ),
      true,
    );
    assert.deepEqual(switchStates(yaml), [{ id: "house_lights", from: "optimistic" }]);
    assert.deepEqual(warnings, ["[cues] pair house_lights presses one button with no state variable"]);
  });

  test("an ordinary pair on two different buttons gets NEITHER comment", () => {
    const { yaml, warnings } = generate([
      press("projectors_on", "Projectors on", SAME),
      press("projectors_off", "Projectors off", OTHER),
    ]);
    const said = comments(yaml).filter((c) => c.includes("toggle") || c.includes("WARNING"));
    assert.deepEqual(said, []);
    assert.deepEqual(warnings, []);
  });
});
