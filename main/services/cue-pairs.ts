// cue-pairs.ts — which cues are two halves of one thing, and what reads its state.
//
// PURE: no I/O, no engine. The settings page imports it — `cuePairs` for the
// rows that may carry a state binding, `stateBindingParams` for what the editor
// writes — so nothing here may reach for a file or a socket.
//
// An ON/OFF pair is the object a voice assistant is asked to turn on and off:
// `<base>_on` and `<base>_off`, which is exactly what the Companion import
// writes. Everything that has to know what a pair IS asks here — the generated
// Home Assistant config, the states route, the rule editor — because the answer
// used to live only inside home-assistant-yaml.ts and a second copy of it is how
// the switch and the sensor would come to disagree about what a pair is.
//
// FORMER NAMES COUNT. A Companion button relabelled on one side of a pair
// renames its cue and keeps the old name as an alias (see cue-aliases.ts), which
// leaves `screens_on` beside `projectors_off` — two halves of one projector that
// pair up under no current name at all. Matching former names as well keeps the
// pair together, and keeps it under the base an already-pasted Home Assistant
// config was written with.
//
// THE STATE BINDING lives on the `_on` half. Companion answers a press the
// moment it hands it to a control and never says what the projector did, so a
// generated switch can only report what it asked for — unless somebody tells
// this app where the answer is. That is a Companion CUSTOM VARIABLE the
// operator's own buttons set: `projectors_state` = `on` / `off`. Stage Utility
// only ever reads it.

import { isCompanionVariableName } from "./companion-export.js";
// From cue-aliases, NOT from the trigger registry: the registry reaches
// node:url, and this module is imported by the settings page.
import { CALL_TRIGGER_ID, parseAliases } from "./cue-aliases.js";
import type { Rule } from "../types/automation.js";

/** The values a bound pair's variable is expected to hold, absent anything else. */
export const STATE_ON_DEFAULT = "on";
export const STATE_OFF_DEFAULT = "off";

/** Where a pair's real state is read from, and what the two answers look like. */
export interface StateBinding {
  /** A Companion custom variable name. */
  variable: string;
  /** The value that means on. Compared trimmed, case-sensitively. */
  onValue: string;
  /** The value that means off. */
  offValue: string;
}

/**
 * The binding in a cue's trigger params, or null when it has none.
 *
 * Stored as three plain params, because `Rule.trigger.params` is
 * `Record<string, string | number>` — the same reason `aliases` is stored
 * comma-joined rather than the type being widened for one field. This module is
 * the only place that knows the keys.
 *
 * A blank `stateVariable` is NO binding, not a binding to "": clearing the
 * select in the editor writes the key with an empty value rather than deleting
 * it, and reading that as a binding would make every such pair permanently
 * unknown.
 */
export function stateBindingOf(params: Record<string, string | number>): StateBinding | null {
  const variable = String(params.stateVariable ?? "").trim();
  if (!variable) return null;
  return {
    variable,
    onValue: String(params.stateOnValue ?? "").trim() || STATE_ON_DEFAULT,
    offValue: String(params.stateOffValue ?? "").trim() || STATE_OFF_DEFAULT,
  };
}

/** The stored form. Every key is written, blank for none, so clearing one saves. */
export function stateBindingParams(binding: Partial<StateBinding> | null): Record<string, string> {
  return {
    stateVariable: binding?.variable?.trim() ?? "",
    stateOnValue: binding?.onValue?.trim() ?? "",
    stateOffValue: binding?.offValue?.trim() ?? "",
  };
}

/**
 * Why this binding cannot be saved, or null when it can.
 *
 * Refused rather than corrected: a variable name Companion could not have is a
 * cue whose state reads 404 forever, and a pair whose on and off values are the
 * same is a switch that says "on" whatever the projector is doing. Both are
 * silent from the operator's side, so both are a 400 at the moment they are
 * typed.
 */
export function stateBindingProblem(params: Record<string, string | number>): string | null {
  const binding = stateBindingOf(params);
  if (!binding) return null;
  if (!isCompanionVariableName(binding.variable)) {
    return `"${binding.variable}" is not a Companion variable name — letters, digits, _, - and . only`;
  }
  if (binding.onValue === binding.offValue) {
    return `the on and off values are both "${binding.onValue}", so the state could never be read`;
  }
  return null;
}

/** One ON/OFF pair among a set of rules. */
export interface CuePair {
  /**
   * The shared base of the two names — `projectors` for `projectors_on` and
   * `projectors_off`. This is the Home Assistant switch's id and the key in
   * `GET /api/cues/states`, so it is the base that MATCHED, which for a
   * half-renamed pair is the former one the pasted config already uses.
   */
  base: string;
  /** The `_on` half's current cue name. */
  onName: string;
  /** The `_off` half's current cue name. */
  offName: string;
  on: Rule;
  off: Rule;
  /** The pair was only found through a former name — one half was renamed. */
  viaFormerName: boolean;
  /** Where this pair's real state is read from, or null for an optimistic pair. */
  binding: StateBinding | null;
}

/** One cue rule, with everything it answers to, current name first. */
interface Keyed {
  rule: Rule;
  name: string;
  keys: string[];
}

/**
 * The ON/OFF pairs among a set of rules, sorted by base.
 *
 * Greedy and deterministic: the cues are walked in rule order and each is tried
 * under its current name before any former one, so a pair that matches by name
 * always wins over one that only matches through an alias, and no cue is ever
 * used by two pairs. Order matters only in configurations the engine already
 * refuses to save (one rule's name being another's former name), and the
 * alternative — a cue in two pairs — is two Home Assistant switches sharing a
 * turn_off.
 *
 * A rule whose cue name is already taken by an earlier rule is skipped, matching
 * the generated config: the engine refuses duplicates, and a hand-built list is
 * read first-wins rather than last.
 */
export function cuePairs(rules: readonly Rule[]): CuePair[] {
  const cues: Keyed[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.trigger.id !== CALL_TRIGGER_ID) continue;
    const name = String(rule.trigger.params.name ?? "").trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    cues.push({ rule, name, keys: [name, ...parseAliases(rule.trigger.params)] });
  }

  // One index of everything every cue answers to. The NAMES are written after
  // the aliases so a current name wins the lookup — the engine refuses a rule
  // whose name is another's former name, and if one ever got in, the live name
  // is the honest answer.
  const index = new Map<string, Keyed>();
  for (const cue of cues) {
    for (const alias of cue.keys.slice(1)) if (!index.has(alias)) index.set(alias, cue);
  }
  for (const cue of cues) index.set(cue.name, cue);

  const claimed = new Set<Keyed>();
  const out: CuePair[] = [];
  for (const cue of cues) {
    for (const key of cue.keys) {
      if (claimed.has(cue)) break;
      if (!key.endsWith("_on")) continue;
      const base = key.slice(0, -"_on".length);
      if (!base) continue;
      const on = index.get(`${base}_on`);
      const off = index.get(`${base}_off`);
      // `on !== cue` is the case where another cue's current name is this one's
      // former name: that cue owns the base, and this one must not claim it.
      if (!on || !off || on !== cue || off === cue || claimed.has(off)) continue;
      claimed.add(cue);
      claimed.add(off);
      out.push({
        base,
        onName: cue.name,
        offName: off.name,
        on: cue.rule,
        off: off.rule,
        viaFormerName: key !== cue.name || `${base}_off` !== off.name,
        // The `_off` half INHERITS the binding, so the operator sets it once.
        // Read from the off half as a fallback rather than ignored, because a
        // hand-edited rules file with it on the other half is otherwise a
        // setting that is saved and does nothing.
        binding:
          stateBindingOf(cue.rule.trigger.params) ?? stateBindingOf(off.rule.trigger.params),
      });
    }
  }

  return out.sort((a, b) => a.base.localeCompare(b.base));
}

/**
 * Both halves press the SAME Companion button.
 *
 * A toggle button — one button, no OFF partner, "VCR Light ON" that is really
 * "VCR Light" — is imported as a pair whose two cues press it from both
 * directions, because a `script` in Home Assistant is a momentary switch that
 * snaps back and each tap toggles the light again. What tells the two
 * directions apart is the state variable, and nothing else: without one, Home
 * Assistant cannot know which way a press went. The generated config says so,
 * and so does the rule editor.
 *
 * Coordinates only — the fingerprint is not compared. Two halves that both
 * carry `p3 r1 c2` are one button whatever their stored labels or action ids
 * say, and a reconcile that has updated one half's fingerprint and not the
 * other's must not make a toggle pair look like an ordinary one.
 */
export function isTogglePair(pair: CuePair): boolean {
  const at = (rule: Rule): string | null => {
    if (rule.action.id !== "companion.press") return null;
    const p = rule.action.params;
    const parts = ["page", "row", "col"].map((k) => Number(p[k]));
    return parts.every((n) => Number.isFinite(n)) ? parts.join(":") : null;
  };
  const on = at(pair.on);
  return on !== null && on === at(pair.off);
}

/** The pairs that have somewhere to read their state from. */
export function boundCuePairs(rules: readonly Rule[]): CuePair[] {
  return cuePairs(rules).filter((p) => p.binding !== null);
}

/**
 * The custom variable an operator most likely means for a pair called `<slug>`,
 * or "" when nothing in Companion matches.
 *
 * `<slug>` and `<slug>_state` only, and case-insensitively. A looser match — a
 * variable whose name merely contains the slug — would bind `projectors` to
 * `projectors_last_error` and report the wrong thing with nobody having chosen
 * it.
 */
export function defaultStateVariable(slug: string, names: readonly string[]): string {
  const want = [slug, `${slug}_state`].map((s) => s.toLowerCase()).filter((s) => s !== "" && s !== "_state");
  for (const candidate of want) {
    const hit = names.find((n) => n.trim().toLowerCase() === candidate);
    if (hit) return hit;
  }
  return "";
}
