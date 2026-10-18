// make-it-a-cue.ts — turn a Button's own action into a manual cue.
//
// A Button set to "Run an action" keeps its action on the widget alone. "Make it a
// cue" lifts that action into a rule triggered by Called by name, so the same
// press can also come from the Automation page, Home Assistant, voice or another
// console, and then points the Button at it.
//
// This file is the pure half (naming, the rule's shape) plus the one write. The
// write goes through the same `automation:addRule` the Automation page uses, so
// the server's own validation, its forced-off rule for a rule with issues and its
// `[automation] rule added` log line all apply; nothing here reimplements them.
//
// A failure is RETURNED, never thrown and never logged away: the caller leaves the
// widget as it was and tells the operator what the server said.

import { CALL_TRIGGER_ID, parseAliases } from "@main/services/cue-aliases";
import { homeVisibilityParams, isPairHalfName } from "@main/services/cue-pairs";
import type { CueManifest } from "@main/services/cue-manifest";
import type { Rule } from "@main/types/automation";
import { errorMessage } from "@main/services/errors";

import { invoke } from "../lib/api";

/** Seconds a cue made this way waits before it may fire again. Short: a Button
 *  is pressed by hand, and two accidental taps should not run it twice. */
export const MADE_CUE_COOLDOWN_SEC = 2;

/** lower_snake_case from any text: accents folded, runs of anything else one
 *  underscore, none at either end. "" when nothing usable is left. */
export function cueSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Every cue name something already answers to: each cue rule's name and former
 * names, and every id and call name in the manifest (which is where the cues the
 * app ships appear, and where a pair's base name lives).
 *
 * The manifest alone would miss a cue hidden from Home Assistant on an older
 * server, and the rules alone would miss the built-ins, so both are read.
 */
export function takenCueNames(rules: readonly Rule[], manifest: CueManifest | null): Set<string> {
  const taken = new Set<string>();
  for (const r of rules) {
    if (r.trigger.id !== CALL_TRIGGER_ID) continue;
    const name = String(r.trigger.params.name ?? "").trim().toLowerCase();
    if (name) taken.add(name);
    for (const alias of parseAliases(r.trigger.params)) taken.add(alias);
  }
  for (const s of manifest?.switches ?? []) {
    taken.add(s.id);
    taken.add(s.on);
    taken.add(s.off);
  }
  for (const b of manifest?.buttons ?? []) {
    taken.add(b.id);
    taken.add(b.cue);
  }
  return taken;
}

/**
 * A cue name for this text that nothing else answers to.
 *
 * Two traps beyond a plain clash. A name ending `_on` or `_off` reads as half of
 * an ON/OFF pair, and a half with no partner is dropped from the manifest, so a
 * Button labelled "Projectors on" would be bound to a cue that never appears: it
 * gets `_cue` appended. An empty slug (a label of only symbols) falls back to
 * `button`.
 */
export function cueNameFor(text: string, taken: ReadonlySet<string>): string {
  let base = cueSlug(text) || "button";
  if (isPairHalfName(base)) base = `${base}_cue`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Rule params hold strings and numbers only; every registry param type is one of
 *  the two, so anything else on a button's `params` is not a value to carry. */
function ruleParams(params: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}

/** The manual cue: Called by name, enabled, a short cooldown, allowed during a
 *  service (no `service.is-not-live` condition), and kept out of Home Assistant
 *  until the operator chooses otherwise. */
export function manualCueRule(opts: {
  name: string;
  cueName: string;
  actionId: string;
  params: Record<string, unknown> | undefined;
}): Omit<Rule, "id"> {
  return {
    name: opts.name,
    enabled: true,
    trigger: {
      id: CALL_TRIGGER_ID,
      params: { name: opts.cueName, says: opts.name, ...homeVisibilityParams(true) },
    },
    conditions: [],
    action: { id: opts.actionId, params: ruleParams(opts.params) },
    cooldownSec: MADE_CUE_COOLDOWN_SEC,
    oncePerService: false,
  };
}

export type MakeCueResult =
  | {
      ok: true;
      /** The new cue's name, which is what a cue-button's `cue` holds. */
      cue: string;
      ruleName: string;
      /** False when the server saved the rule turned off because it has issues. */
      enabled: boolean;
    }
  | { ok: false; error: string };

/** The seam a test replaces; production reads and writes through `invoke`. */
export const makeCueDeps = {
  rules: () => invoke<{ rules: Rule[] }>("automation:rules"),
  manifest: () => invoke<CueManifest>("cues:manifest"),
  addRule: (rule: Omit<Rule, "id">) => invoke<Rule>("automation:addRule", rule),
};

/**
 * Create the manual cue for a Button's action. Resolves with the new cue's name,
 * or with the reason it could not — the rule list or manifest could not be read,
 * or the server refused the rule.
 */
export async function makeCueFromAction(opts: {
  /** The Button's own label; blank falls back to the action's name. */
  label: string;
  actionId: string;
  actionLabel: string;
  params: Record<string, unknown> | undefined;
}): Promise<MakeCueResult> {
  const ruleName = opts.label.trim() || opts.actionLabel.trim() || opts.actionId;
  try {
    const [{ rules }, manifest] = await Promise.all([makeCueDeps.rules(), makeCueDeps.manifest()]);
    const taken = takenCueNames(rules, manifest);
    // The label first, the action's name when the label has no letters in it.
    const cueName = cueNameFor(cueSlug(ruleName) ? ruleName : opts.actionLabel, taken);
    const created = await makeCueDeps.addRule(
      manualCueRule({ name: ruleName, cueName, actionId: opts.actionId, params: opts.params }),
    );
    return { ok: true, cue: cueName, ruleName, enabled: created.enabled !== false };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
