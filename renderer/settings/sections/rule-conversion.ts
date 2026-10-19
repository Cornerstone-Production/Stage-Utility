// rule-conversion.ts — turning a rule into a manual cue, and a manual cue into an
// automatic rule, in the editor's draft.
//
// PURE. The editor applies these to its DRAFT; nothing is written until Save, so
// Cancel puts everything back.
//
// A MANUAL CUE and an AUTOMATIC RULE differ in one thing: the trigger. A manual
// cue's is Called by name, and carries the cue name (the URL, and the Home
// Assistant entity id), the spoken name, the room and the former names. Everything
// else — the action, the name, whether it is on, the cooldown — is the rule's own
// and is kept.
//
// A CUE NAME IS NEVER RENAMED BY A CONVERSION. Home Assistant's entity and every
// pasted URL are made from it. Going manual → automatic drops it, which is a LOSS
// and is said so at Save (see homeImpact); coming back in the same editing session
// restores the trigger exactly as the editor opened it, name, former names and all,
// rather than deriving a new one that might differ.

import { CALL_TRIGGER_ID } from "@main/services/cue-aliases";
import { deriveCueName } from "@main/services/cue-name";
import { homeVisibilityParams, isHiddenFromHome, isPairHalfName } from "@main/services/cue-pairs";
import type { Rule } from "@main/types/automation";

/**
 * The automatic rule a manual cue becomes: the same rule with NO trigger yet.
 *
 * The trigger is the operator's to choose, and guessing one would save a rule that
 * fires on something they never picked. The editor will not Save until one is.
 */
export function makeAutomatic(rule: Rule): Rule {
  return { ...rule, trigger: { id: "", params: {} } };
}

/**
 * The manual cue a rule becomes.
 *
 * `seed` is the rule as the editor opened it. When that was already a cue (the
 * operator pressed Make it automatic and has changed their mind) its trigger is put
 * back exactly. Otherwise the cue name is derived from the rule's name, not a name
 * in `taken`, and Home Assistant is OFF: a conversion must not publish an entity
 * nobody asked for. The operator can switch it on, and Save says so when they do.
 */
export function makeManual(rule: Rule, seed: Rule, taken: ReadonlySet<string>): Rule {
  if (seed.trigger.id === CALL_TRIGGER_ID) return { ...rule, trigger: seed.trigger };
  return {
    ...rule,
    trigger: {
      id: CALL_TRIGGER_ID,
      params: { name: deriveCueName(rule.name, taken), ...homeVisibilityParams(true) },
    },
  };
}

/**
 * The cue name Home Assistant has an entity for on this rule, or null.
 *
 * Not a cue, a cue switched off for Home Assistant, and a cue named like half of an
 * ON/OFF pair with no partner (which the manifest leaves out) all have none.
 */
export function homeEntity(rule: Pick<Rule, "trigger">): string | null {
  if (rule.trigger.id !== CALL_TRIGGER_ID) return null;
  const name = String(rule.trigger.params.name ?? "").trim().toLowerCase();
  if (!name || isPairHalfName(name) || isHiddenFromHome(rule.trigger.params)) return null;
  return name;
}

export type HomeImpact = { kind: "lose" | "gain"; cue: string };

/**
 * What a CONVERSION saved over `seed` does to Home Assistant, or null when nothing.
 *
 * LOSE: a cue it had an entity for is no longer one. Its automations, and the
 * HomeKit switch made from it, stop working. GAIN: a rule it had nothing for is a
 * shown cue now, which a pasted YAML fragment will not have.
 *
 * ONLY WHEN THE TRIGGER KIND CHANGED. The editor's own Home Assistant switch
 * already says, beside itself, that turning it off removes the entity, and has
 * always saved without a second question; asking again there would be a new prompt
 * on an old control. What had no warning anywhere is a button that quietly changes
 * what the rule IS.
 */
export function homeImpact(seed: Rule, draft: Rule): HomeImpact | null {
  if (seed.trigger.id === draft.trigger.id) return null;
  const before = homeEntity(seed);
  const after = homeEntity(draft);
  if (before && !after) return { kind: "lose", cue: before };
  if (!before && after) return { kind: "gain", cue: after };
  return null;
}

/** The question Save asks before it does either. */
export function impactQuestion(impact: HomeImpact): { title: string; message: string; confirmLabel: string } {
  return impact.kind === "lose"
    ? {
        title: "Home Assistant will lose this cue",
        message: `${impact.cue} stops existing: Home Assistant removes its entity within a few seconds, automations there that refer to it stop working, and anything calling /api/cues/${impact.cue} stops finding it.`,
        confirmLabel: "Save anyway",
      }
    : {
        title: "Home Assistant will get a new cue",
        message: `${impact.cue} becomes a button in Home Assistant and Apple Home. The Home Assistant integration picks it up by itself; a pasted YAML fragment needs to be generated and pasted again.`,
        confirmLabel: "Save",
      };
}
