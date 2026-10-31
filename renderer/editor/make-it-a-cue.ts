// make-it-a-cue.ts — turn a Button's own action into a manual cue.
//
// A Button set to "Run an action" keeps its action on the widget alone. "Make it a
// cue" lifts that action into a rule triggered by Called by name, so the same
// press can also come from the Automation page, Home Assistant, voice or another
// console, and then points the Button at it.
//
// This file is the pure half (naming, the rule's shape) plus the one write. The
// write goes through the same `automation:addRule` the Automation page uses, so
// the server's own validation and its `[automation] rule added` log line apply;
// nothing here reimplements them. The rule is posted enabled, and the server
// refuses an enabled rule that has issues (409), so a rule that needs setup comes
// back as a failure rather than as one saved turned off.
//
// A failure is RETURNED, never thrown and never logged away: the caller leaves the
// widget as it was and tells the operator what the server said.

import { CALL_TRIGGER_ID, parseAliases } from "@main/services/cue-aliases";
import { homeVisibilityParams } from "@main/services/cue-pairs";
import { chosenLabel, cueNameFor, cueSlug } from "@main/services/cue-naming";
import type { CueManifest } from "@main/services/cue-manifest";
import type { Rule } from "@main/types/automation";
import { errorMessage } from "@main/services/errors";

import { invoke } from "../lib/api";

// The naming is shared with the server, which names a migrated Button's cue the same way.
export { chosenLabel, cueNameFor, cueSlug };

/** Seconds a cue made this way waits before it may fire again. Short: a Button
 *  is pressed by hand, and two accidental taps should not run it twice. */
const MADE_CUE_COOLDOWN_SEC = 2;

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
function manualCueRule(opts: {
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

type MakeCueResult =
  | {
      ok: true;
      /** The cue's name, which is what a cue-button's `cue` holds. */
      cue: string;
      /** The cue already existed (a rule of this name and action, made by an earlier press), so nothing was written. */
      reused: boolean;
    }
  | { ok: false; error: string };

/** The name of an enabled Called-by-name rule that is this very cue: the same name, action and parameters. */
function existingCue(rules: readonly Rule[], name: string, actionId: string, params: Record<string, string | number>): string | null {
  const same = (a: Record<string, string | number>, b: Record<string, string | number>) =>
    JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  for (const r of rules) {
    if (r.trigger.id !== CALL_TRIGGER_ID || !r.enabled || r.name !== name || r.action?.id !== actionId) continue;
    const cue = String(r.trigger.params.name ?? "").trim();
    if (cue && same(ruleParams(r.action.params), params)) return cue;
  }
  return null;
}

/**
 * Create the manual cue for a Button's action. Resolves with the cue's name (an existing one when it is already this action),
 * or with the reason it could not — the rule list or manifest could not be read,
 * or the server refused the rule.
 */
export async function makeCueFromAction(opts: {
  /** The Button's own label; blank, or the old default "Action", falls back to the
   *  action's name. */
  label: string | undefined;
  actionId: string;
  actionLabel: string;
  params: Record<string, unknown> | undefined;
}): Promise<MakeCueResult> {
  try {
    const ruleName = chosenLabel(opts.label) ?? (opts.actionLabel.trim() || opts.actionId);
    const [{ rules }, manifest] = await Promise.all([
      invoke<{ rules: Rule[] }>("automation:rules"),
      invoke<CueManifest>("cues:manifest"),
    ]);
    // Leaving the editor without saving strands the cue this wrote, and pressing again would
    // mint name_2 beside it: the cue that is already this Button's action is offered instead.
    const earlier = existingCue(rules, ruleName, opts.actionId, ruleParams(opts.params));
    if (earlier) return { ok: true, cue: earlier, reused: true };
    const taken = takenCueNames(rules, manifest);
    // The label first, the action's name when the label has no letters in it.
    const cueName = cueNameFor(cueSlug(ruleName) ? ruleName : opts.actionLabel, taken);
    const rule = manualCueRule({ name: ruleName, cueName, actionId: opts.actionId, params: opts.params });
    await invoke<Rule>("automation:addRule", rule);
    return { ok: true, cue: cueName, reused: false };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
