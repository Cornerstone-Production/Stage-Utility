// owned-press.ts — the command that belongs to one Button.
//
// A Button stores one thing, a command's name. Choosing a Companion button or an
// app action on it makes a command that exists for that Button alone (a Called by
// name rule carrying `ownedBy`), so every guard a command has applies to the press:
// Simulate, Disarm, the service guard and the activity log. This file is the pure
// half (finding the Button's own rule, what kind of press it is) and the two writes.
//
// The rule is written when the pick is made, not when the layout is saved. Picking
// again on the same Button rewrites that rule in place, found by `ownedBy`, so the
// command's name does not change when the label or the pick does, and leaving the
// editor without saving strands nothing that a second pick would not reuse.
//
// A failure is RETURNED, never thrown and never logged away: the caller leaves the
// Button as it was and tells the operator what the server said. The server logs
// the rule it adds or rewrites on a tagged `[automation]` line, owner included.

import { calledCueName } from "@main/services/cue-aliases";
import { buttonCueRule, chosenLabel, cueNameFor, cueSlug, namesTakenForNewCue } from "@main/services/cue-naming";
import type { CueManifest } from "@main/services/cue-manifest";
import { errorMessage } from "@main/services/errors";
import type { OwnedBy, Rule } from "@main/types/automation";

import { invoke } from "../lib/api";

/** What a Button presses: a Companion button, an app action, or an existing command. */
export type PressKind = "companion" | "action" | "command";

/** The Button a rule belongs to: the view it is on, `"home"` for Home, and its object id. */
export type PressOwner = OwnedBy;

/** The action id that presses one Companion button. */
export const COMPANION_PRESS = "companion.press";

const sameOwner = (a: OwnedBy | undefined, b: OwnedBy) => !!a && a.viewId === b.viewId && a.objectId === b.objectId;

/**
 * The rule that belongs to this Button, or null. When more than one names it (a
 * hand-edited file), the one the Button is bound to wins, so the editor reads the
 * rule the Button actually presses.
 */
export function ownedRuleFor(rules: readonly Rule[], owner: PressOwner, cue: string): Rule | null {
  const mine = rules.filter((r) => sameOwner(r.ownedBy, owner));
  const bound = cue.trim().toLowerCase();
  return mine.find((r) => bound !== "" && calledCueName(r.trigger) === bound) ?? mine[0] ?? null;
}

/**
 * Which choice the Presses control shows for a Button: its own rule's action
 * decides Companion or App action, a cue naming anything else is A command, and a
 * Button with no cue yet has made no choice (null).
 */
export function pressKindOf(rules: readonly Rule[], owner: PressOwner, cue: string): PressKind | null {
  const own = ownedRuleFor(rules, owner, cue);
  const bound = cue.trim().toLowerCase();
  // A Button re-pointed at another command leaves its old rule behind, owned and
  // unused: that Button is on A command, not on the rule it no longer presses.
  if (own && bound !== "" && calledCueName(own.trigger) === bound) {
    return own.action.id === COMPANION_PRESS ? "companion" : "action";
  }
  return bound === "" ? null : "command";
}

/** What a pick presses, and what it is called. */
export interface PressTarget {
  action: Rule["action"];
  /** The picked button's or action's own name: the rule's name when the Button has no label. */
  name: string;
}

type Wrote = { ok: true; cue: string; rule: Rule } | { ok: false; error: string };

/**
 * Make, or rewrite, the command that belongs to this Button.
 *
 * The rule list and the manifest are read fresh, because the names taken and the
 * Button's own rule are facts about the server, and a cached list is how two picks
 * in a row would mint `btn_x` and `btn_x_2`. A rule that already belongs to this
 * Button has its action and name rewritten and is switched on; its trigger, and so
 * the command's name, is left alone.

 */
export async function writeOwnedRule(opts: {
  owner: PressOwner;
  /** The command the Button is bound to now ("" for none), to pick between rules when several name it. */
  cue: string;
  /** The Button's own label; blank, or the old default, falls back to the pick's name. */
  label: string | undefined;
  target: PressTarget;
}): Promise<Wrote> {
  try {
    const ruleName = chosenLabel(opts.label) ?? (opts.target.name.trim() || opts.target.action.id);
    const { rules } = await invoke<{ rules: Rule[] }>("automation:rules");
    const existing = ownedRuleFor(rules, opts.owner, opts.cue);
    if (existing) {
      // `says` is what a Button with no label of its own draws (the manifest names a command
      // by it), so it follows the pick; the command's own name, beside it, never changes.
      const trigger = { id: existing.trigger.id, params: { ...existing.trigger.params, says: ruleName } };
      const patch = { name: ruleName, action: opts.target.action, enabled: true, trigger };
      await invoke("automation:updateRule", { id: existing.id, patch });
      return { ok: true, cue: calledCueName(existing.trigger), rule: { ...existing, ...patch } };
    }
    const manifest = await invoke<CueManifest>("cues:manifest");
    const taken = namesTakenForNewCue(rules, manifest);
    // The label first, the pick's name when the label has no letters in it.
    const cueName = cueNameFor(cueSlug(ruleName) ? ruleName : opts.target.name, taken, "btn_");
    const made = await invoke<Rule>(
      "automation:addRule",
      // `says` because a Button with no label draws the command's spoken name, and without it the
      // manifest falls back to the cue name humanised: "Btn Shutter" for a button called Shutter.
      buttonCueRule({ name: ruleName, cueName, action: opts.target.action, ownedBy: opts.owner, says: ruleName }),
    );
    return { ok: true, cue: cueName, rule: made };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * List the Button's own command with the other commands: it stops belonging to its
 * Button. Nothing else changes, and the Button keeps pressing it. The rule is looked
 * up now, not taken from what the panel last drew, so a write that has just landed is
 * the one released.
 */
export async function listWithCommands(owner: PressOwner, cue: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { rules } = await invoke<{ rules: Rule[] }>("automation:rules");
    const own = ownedRuleFor(rules, owner, cue);
    if (!own) return { ok: false, error: "This Button has no command of its own to list." };
    await invoke("automation:updateRule", { id: own.id, patch: { ownedBy: null } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
