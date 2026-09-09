// home-assistant-yaml.ts — the Home Assistant config for the cues on this server.
//
// PURE: rules in, YAML text out. Generated rather than written by hand because
// the two have to agree exactly — a cue renamed here and not there is a switch
// that answers "unavailable" with nothing anywhere saying why — and because
// somebody adding a cue should not have to learn Home Assistant's REST syntax.
//
// Two objects per cue set:
//
//  - a `rest_command` per cue, which is the plain "call this URL" primitive, and
//  - a template `switch` per ON/OFF pair, which is what a voice assistant can be
//    asked to turn on and off by name.
//
// The switches are `optimistic: true`: Stage Utility can tell Home Assistant it
// DISPATCHED the press and nothing more. Companion answers 200 the moment it
// hands the press to a control, and nothing in this chain reads the projector
// back. An optimistic switch says "I have asked" rather than lying about state
// it does not have.

import { CALL_TRIGGER_ID } from "./automation-triggers.js";
import type { Rule } from "../types/automation.js";

/** One cue, reduced to what the config needs. */
interface Cue {
  name: string;
  friendly: string;
}

/** A cue set the assistant can turn on and off. */
interface Pair {
  base: string;
  friendly: string;
  on: string;
  off: string;
}

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
 * The `_on`/`_off` cues that belong together.
 *
 * Matched on the name suffix, which is exactly what the Companion import
 * generates. A hand-written cue that follows the same convention is picked up
 * for free; one that does not still gets its `rest_command`, so nothing is
 * silently dropped — it just has no switch to say on and off to.
 */
function pairsOf(cues: Map<string, Cue>): Pair[] {
  const out: Pair[] = [];
  for (const [name, cue] of cues) {
    if (!name.endsWith("_on")) continue;
    const base = name.slice(0, -"_on".length);
    const off = cues.get(`${base}_off`);
    if (!off || !base) continue;
    // The friendly name loses the "on": the switch is the THING, and Home
    // Assistant supplies the verb. "Turn on Projectors on" is what happens
    // otherwise.
    const friendly = cue.friendly.replace(/\s+on$/i, "").trim() || base;
    out.push({ base, friendly, on: name, off: `${base}_off` });
  }
  return disambiguate(out).sort((a, b) => a.base.localeCompare(b.base));
}

/** "ma_conf_tvs" -> "Ma Conf Tvs". The cue name is all there is to go on. */
function humanise(base: string): string {
  return base
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * No two switches may share a `friendly_name`.
 *
 * The Companion import already does this on the way in — a base found on two
 * pages is spoken with its page name — but a hand-written pair has no page, and
 * two rules both saying "Projectors" put two identical switches into Home
 * Assistant, where the operator picks one at random and finds out which in the
 * middle of a service. The cue names cannot collide (the engine refuses that), so
 * falling back to the name is guaranteed to separate them.
 */
function disambiguate(pairs: Pair[]): Pair[] {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    const key = p.friendly.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return pairs.map((p) =>
    (counts.get(p.friendly.toLowerCase()) ?? 0) > 1 ? { ...p, friendly: humanise(p.base) } : p,
  );
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
    cues.set(name, { name, friendly: friendlyOf(rule) });
  }

  const base = baseUrl.replace(/\/+$/, "");
  const lines: string[] = [
    "# Stage Utility cues — generated. Paste into configuration.yaml.",
    "#",
    "# Put the token you were shown when you minted it into secrets.yaml, WITH",
    "# the scheme, because this is the whole Authorization header:",
    "#",
    '#   stage_utility_token: "Bearer su_..."',
    "#",
    "# Switches are optimistic: Stage Utility reports that it dispatched the",
    "# press, never that the device did anything. Home Assistant shows what it",
    "# asked for, not what happened.",
    "",
  ];

  if (cues.size === 0) {
    lines.push("# No cues yet. Add a rule triggered by \"Called by name\" and reload this.");
    return lines.join("\n") + "\n";
  }

  lines.push("rest_command:");
  for (const cue of cues.values()) {
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

  const pairs = pairsOf(cues);
  if (pairs.length > 0) {
    lines.push("", "switch:", "  - platform: template", "    switches:");
    for (const p of pairs) {
      lines.push(
        `      ${p.base}:`,
        `        friendly_name: ${q(p.friendly)}`,
        "        optimistic: true",
        "        turn_on:",
        `          action: rest_command.su_${p.on}`,
        "        turn_off:",
        `          action: rest_command.su_${p.off}`,
      );
    }
  }

  return lines.join("\n") + "\n";
}
