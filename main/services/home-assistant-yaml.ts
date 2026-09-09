// home-assistant-yaml.ts — the Home Assistant config for the cues on this server.
//
// PURE: rules in, YAML text out. Generated rather than written by hand because
// the two have to agree exactly — a cue renamed here and not there is a switch
// that answers "unavailable" with nothing anywhere saying why — and because
// somebody adding a cue should not have to learn Home Assistant's REST syntax.
//
// Three objects per cue set:
//
//  - a `rest_command` per cue, which is the plain "call this URL" primitive,
//  - a template `switch` per ON/OFF pair, which is what a voice assistant can be
//    asked to turn on and off by name, and
//  - a `script` per cue that is NOT half of a pair, which is what an assistant
//    can be asked to RUN. A one-shot button has no on and no off; a switch for
//    it would sit in Home Assistant permanently claiming a state it never had.
//
// A cue is never both. A pair's two halves are exactly the cues whose names end
// `_on`/`_off` with a partner present, and those are excluded from the scripts.
//
// A switch is `optimistic: true` UNLESS its pair names a Companion custom
// variable to read its state from. Optimistic is the honest spelling of what
// Companion tells us: it answers 200 the moment it hands the press to a control
// and nothing in that chain reads the projector back, so the switch says "I have
// asked" rather than lying about a state it does not have.
//
// A pair with a state variable gets the truth instead. One `rest` sensor polls
// `GET /api/cues/states` every ten seconds and lifts each bound pair into an
// attribute; the switch reads its own attribute off that sensor. ONE sensor for
// every pair, not one each: Home Assistant polls each `rest` resource on its own
// schedule, and eight sensors on one URL is eight times the requests for the
// same answer. See cue-states.ts.

import { CALL_TRIGGER_ID } from "./automation-triggers.js";
import { parseAliases } from "./cue-aliases.js";
import { cuePairs, type StateBinding } from "./cue-pairs.js";
import type { Rule } from "../types/automation.js";

/** One cue, reduced to what the config needs. */
interface Cue {
  name: string;
  friendly: string;
  /** Names it used to have and still answers to. See cue-aliases.ts. */
  formerNames: string[];
}

/** A cue set the assistant can turn on and off. */
interface Pair {
  base: string;
  friendly: string;
  on: string;
  off: string;
  /** Where its real state is read from, or null for an optimistic switch. */
  binding: StateBinding | null;
}

/** The `rest` sensor every bound pair's switch reads its attribute off. */
const SENSOR_ENTITY = "sensor.stage_utility_cues";

/**
 * YAML double-quoted scalar.
 *
 * A double-quoted YAML scalar cannot contain a literal newline, tab or carriage
 * return and stay one scalar: a `says` typed with a line break in it broke the
 * whole document, so Home Assistant lost every cue rather than one friendly
 * name. They go in as YAML's own escapes, which a double-quoted scalar reads back
 * exactly.
 */
function q(text: string): string {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/** The name a person would say for a cue, from `says` or the rule's own name. */
function friendlyOf(rule: Rule): string {
  const says = String(rule.trigger.params.says ?? "").trim();
  return says || rule.name.trim() || String(rule.trigger.params.name ?? "");
}

/**
 * The `_on`/`_off` cues that belong together, and what reads each one's state.
 *
 * The pairing itself is cue-pairs.ts and deliberately not a second copy of it:
 * this file and `GET /api/cues/states` have to agree exactly about what a pair
 * is, or a switch reads an attribute the sensor never publishes. That also means
 * a half-renamed pair — one Companion button relabelled, the other not — keeps
 * its switch, under the base the already-pasted config uses.
 *
 * A hand-written cue that follows the `_on`/`_off` convention is picked up for
 * free; one that does not still gets its `rest_command`, so nothing is silently
 * dropped — it just has no switch to say on and off to.
 */
function pairsOf(rules: Rule[], cues: Map<string, Cue>): Pair[] {
  const out: Pair[] = [];
  for (const pair of cuePairs(rules)) {
    const cue = cues.get(pair.onName);
    if (!cue) continue;
    // The friendly name loses the "on": the switch is the THING, and Home
    // Assistant supplies the verb. "Turn on Projectors on" is what happens
    // otherwise.
    const friendly = cue.friendly.replace(/\s+on$/i, "").trim() || pair.base;
    out.push({
      base: pair.base,
      friendly,
      on: pair.onName,
      off: pair.offName,
      binding: pair.binding,
    });
  }
  return out.sort((a, b) => a.base.localeCompare(b.base));
}

/** "ma_conf_tvs" -> "Ma Conf Tvs". The cue name is all there is to go on. */
function humanise(base: string): string {
  return base
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** One object in the generated config that carries a name a person says. */
interface Spoken {
  /** `switch:<base>` or `script:<cue name>`. Unique across the document. */
  key: string;
  /** `switch` or `script` — Home Assistant's own two domains. */
  kind: "switch" | "script";
  /** The id it gets in its domain: a pair's base, or a script's cue name. */
  id: string;
  /** The words, from `says` or the rule's name. */
  friendly: string;
}

/**
 * No two objects may share the name a person says — ACROSS THE KINDS, not
 * within each.
 *
 * A switch's `friendly_name` and a script's `alias` are the same thing to a
 * voice assistant: the words somebody says out loud. Two of them saying
 * "Projectors" is an assistant that picks one at random, and the operator finds
 * out which in the middle of a service. Disambiguating the switches on their own
 * — which is all this did — left two scripts whose cues have the same `says`
 * both called that, and a switch and a script colliding with each other
 * entirely unhandled.
 *
 * The Companion import already separates most of this on the way in: a name
 * found on two pages is spoken with its page name (see cueSlugs). A
 * hand-written cue has no page, and two operators typing the same `says` is
 * exactly what this catches.
 *
 * Three tiers, and every collision is resolved by the second or the third:
 *
 *  1. the words, when this is the only object saying them,
 *  2. else the id humanised — a pair's base, a script's cue name. Ids are
 *     unique WITHIN a kind, because a pair is keyed by a cue name the engine
 *     refuses to duplicate,
 *  3. else the id humanised with its domain, which separates the one case tier
 *     2 cannot: a pair based `projectors` and a one-shot cue called
 *     `projectors`, which are `switch.projectors` and `script.projectors` in
 *     Home Assistant and two different things.
 *
 * Returned as a map rather than a rewritten list so the switches and the scripts
 * can be emitted from their own loops while sharing one answer.
 */
function friendlyNames(items: readonly Spoken[]): Map<string, string> {
  const tally = (of: (item: Spoken) => string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = of(item).toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const said = tally((i) => i.friendly);
  const humanised = tally((i) => humanise(i.id));

  const out = new Map<string, string>();
  for (const item of items) {
    if ((said.get(item.friendly.toLowerCase()) ?? 0) < 2) {
      out.set(item.key, item.friendly);
      continue;
    }
    const fallback = humanise(item.id);
    out.set(
      item.key,
      (humanised.get(fallback.toLowerCase()) ?? 0) < 2 ? fallback : `${fallback} (${item.kind})`,
    );
  }
  return out;
}

/**
 * The whole configuration.yaml fragment.
 *
 * `baseUrl` is this server as Home Assistant can reach it — a LAN IP, never a
 * name: Home Assistant may well be on a box with different DNS, and a cue that
 * resolves in a browser and not in HA fails at the worst possible moment.
 */
export function homeAssistantYaml(rules: Rule[], baseUrl: string): string {
  const cues = new Map<string, Cue>();
  for (const rule of rules) {
    if (rule.trigger.id !== CALL_TRIGGER_ID) continue;
    const name = String(rule.trigger.params.name ?? "").trim().toLowerCase();
    if (!name || cues.has(name)) continue;
    cues.set(name, {
      name,
      friendly: friendlyOf(rule),
      formerNames: parseAliases(rule.trigger.params),
    });
  }

  const base = baseUrl.replace(/\/+$/, "");
  // Before the header, because the header says whether the switches report real
  // state and that is a property of the pairs.
  const pairs = pairsOf(rules, cues);
  const bound = pairs.filter((p) => p.binding !== null);
  const lines: string[] = [
    "# Stage Utility cues — generated. Paste into configuration.yaml.",
    "#",
    "# Put the token you were shown when you minted it into secrets.yaml, WITH",
    "# the scheme, because this is the whole Authorization header:",
    "#",
    '#   stage_utility_token: "Bearer su_..."',
    "#",
    ...(bound.length > 0
      ? [
          "# A pair with a state variable reports what its device is actually doing,",
          "# read from Companion through the rest sensor below.",
          "# Every other switch is optimistic: Stage Utility reports that it",
          "# dispatched the press, never that the device did anything.",
        ]
      : [
          "# Switches are optimistic: Stage Utility reports that it dispatched the",
          "# press, never that the device did anything. Home Assistant shows what it",
          "# asked for, not what happened.",
        ]),
    "",
  ];

  if (cues.size === 0) {
    lines.push("# No cues yet. Add a rule triggered by \"Called by name\" and reload this.");
    return lines.join("\n") + "\n";
  }

  lines.push("rest_command:");
  for (const cue of cues.values()) {
    // A renamed cue is CALLED OUT, and its former names are deliberately not
    // emitted as commands of their own. They exist so that the copy of this file
    // somebody pasted before the rename keeps working; generating them here
    // would put a second command on one cue and leave Home Assistant with two
    // names for one thing forever.
    if (cue.formerNames.length > 0) {
      const was = cue.formerNames.map((n) => `su_${n}`).join(", ");
      lines.push(
        cue.formerNames.length === 1
          ? `  # renamed from ${was}; the old rest_command keeps working until you re-paste`
          : `  # renamed from ${was}; the old rest_commands keep working until you re-paste`,
      );
    }
    lines.push(
      `  su_${cue.name}:`,
      `    url: ${q(`${base}/api/cues/${cue.name}`)}`,
      "    method: post",
      "    headers:",
      "      authorization: !secret stage_utility_token",
      '    content_type: "application/json"',
      '    payload: "{}"',
    );
  }

  const paired = new Set(pairs.flatMap((p) => [p.on, p.off]));
  // Every cue that is not half of a pair.
  const scripts = [...cues.values()].filter((c) => !paired.has(c.name));

  // ONE disambiguation over both kinds. A switch's friendly_name and a script's
  // alias are the same thing to a voice assistant, so they cannot be separated
  // one list at a time. See friendlyNames.
  const spoken = friendlyNames([
    ...pairs.map((p): Spoken => ({ key: `switch:${p.base}`, kind: "switch", id: p.base, friendly: p.friendly })),
    ...scripts.map((c): Spoken => ({ key: `script:${c.name}`, kind: "script", id: c.name, friendly: c.friendly })),
  ]);

  // ONE `rest` sensor for every bound pair, and only when there is one. Its
  // state is `checkedAt` — a value that changes on every poll, so the sensor is
  // visibly alive — and each pair's row is lifted into an attribute by
  // `json_attributes_path` + `json_attributes`, which is Home Assistant's
  // documented way to read a nested object.
  if (bound.length > 0) {
    lines.push(
      "",
      "# Real state, read from the Companion custom variables your ON/OFF buttons",
      "# set. One sensor for every pair; the switches below read their attribute",
      "# off it. Nothing here writes a variable.",
      "#",
      "# An `unknown` pair — Companion unreachable, the variable missing, or a value",
      "# matching neither of the two — reads OFF here and stays PRESSABLE; the reason",
      "# is on this sensor's attribute for that pair, and on the rule's row in Stage",
      "# Utility. No availability_template on purpose: an unavailable switch cannot",
      "# be commanded, so an unreachable Companion would also stop you turning the",
      "# device on.",
      "rest:",
      `  - resource: ${q(`${base}/api/cues/states`)}`,
      "    scan_interval: 10",
      "    sensor:",
      '      - name: "Stage Utility cues"',
      "        unique_id: stage_utility_cues",
      '        value_template: "{{ value_json.checkedAt }}"',
      '        json_attributes_path: "$.states"',
      "        json_attributes:",
      // QUOTED, all three of the places a cue name or a base becomes a YAML
      // scalar of its own. Home Assistant parses YAML 1.1, which reads a bare
      // `no`, `on`, `off`, `yes`, `true` and `false` (and, in the 1.1 spec,
      // `y` and `n`) as a BOOLEAN — so a pair called `no_on`/`no_off` asked the
      // sensor for the attribute `false` and gave the switch block a key that
      // was not a string. `su_` prefixed keys are exempt: a prefixed name cannot
      // be one of those words.
      ...bound.map((p) => `          - ${q(p.base)}`),
    );
  }

  if (pairs.length > 0) {
    lines.push("", "switch:", "  - platform: template", "    switches:");
    for (const p of pairs) {
      lines.push(
        `      ${q(p.base)}:`,
        `        friendly_name: ${q(spoken.get(`switch:${p.base}`) ?? p.friendly)}`,
        // A bound pair reads its state; an unbound one can only report what it
        // asked for. `optimistic: true` is dropped for a bound pair rather than
        // left beside the template: optimistic means "believe the press
        // immediately and do not wait for the state", which is precisely the
        // behaviour a state variable exists to replace.
        //
        // `(… or {}).get('state')` rather than `….state`: before the sensor's
        // first poll the attribute does not exist, and `None.state` throws in
        // Jinja — which puts a template error in Home Assistant's log at every
        // restart and leaves the switch unavailable with no explanation. An
        // `unknown` pair reads OFF here, because the legacy template switch has
        // no third state; the reason is on the sensor's own attribute and on the
        // rule's row in Stage Utility.
        //
        // And NO `availability_template`, which is the obvious way to say
        // "unknown" and the wrong one: an unavailable entity cannot be
        // commanded. An unreachable Companion would then also stop the operator
        // turning the device ON — the press path does not depend on the state
        // variable at all, so a read failure must never take the switch away.
        // Reading off and staying pressable is the trade taken deliberately.
        ...(p.binding
          ? [
              `        value_template: "{{ (state_attr('${SENSOR_ENTITY}', '${p.base}') or {}).get('state') == 'on' }}"`,
            ]
          : ["        optimistic: true"]),
        "        turn_on:",
        `          action: rest_command.su_${p.on}`,
        "        turn_off:",
        `          action: rest_command.su_${p.off}`,
      );
    }
  }

  // `action:` rather than the deprecated `service:`, matching the switches
  // above — Home Assistant renamed it in 2024.8 and a fragment that used both
  // spellings would read as two eras.
  if (scripts.length > 0) {
    lines.push("", "script:");
    for (const cue of scripts) {
      lines.push(
        `  ${q(cue.name)}:`,
        `    alias: ${q(spoken.get(`script:${cue.name}`) ?? cue.friendly)}`,
        "    sequence:",
        `      - action: rest_command.su_${cue.name}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}
