// rule-search.ts — what a rule offers up to the rules-list search field.
//
// PURE: builds one haystack per rule and matches it case-insensitively against
// the operator's query. Kept separate from automation-section.tsx so the seven
// fields it has to cover — name, cue name, says, the words the ROW shows, former
// names, a Companion button's label, and the trigger/action ids' human labels —
// are one function this file's own tests can drive without mounting the section.
// A command is also found by the screens it is used on, which the caller reads off
// the usage and passes in.

import { CALL_TRIGGER_ID, parseAliases } from "@main/services/cue-aliases";

interface RuleLike {
  name: string;
  trigger: { id: string; params: Record<string, string | number> };
  action: { id: string; params: Record<string, string | number> };
}

interface SpecLike {
  id: string;
  label: string;
}

/**
 * Every word a search should find this rule by, lower-cased and space-joined.
 *
 * `triggerLabel`/`actionLabel` are passed in rather than looked up here: the
 * registry is what the section already has loaded, and a rule whose trigger
 * or action id is not (yet) in it — an upgrade mid-flight — still matches on
 * everything else instead of throwing.
 */
export function ruleSearchText(
  rule: RuleLike,
  triggerLabel: string | undefined,
  actionLabel: string | undefined,
  /** The names of the screens (and Button labels) a command is used on. Only a command has any. */
  usedOn: readonly string[] = [],
): string {
  const parts: string[] = [rule.name, ...usedOn];
  if (rule.trigger.id === CALL_TRIGGER_ID) {
    const cueName = String(rule.trigger.params.name ?? "");
    parts.push(cueName);
    parts.push(String(rule.trigger.params.says ?? ""));
    // The words on a row are the rule's `says`, else its own name, else the cue
    // name humanised (spokenCueName), and all but the last are already here: the
    // humanised name holds nothing the cue name above does not.
    parts.push(...parseAliases(rule.trigger.params));
  }
  if (rule.action.id === "companion.press") {
    parts.push(String(rule.action.params.label ?? ""));
  }
  if (triggerLabel) parts.push(triggerLabel);
  if (actionLabel) parts.push(actionLabel);
  return parts.join(" ").toLowerCase();
}

/** Whether `rule` matches `query` — a case-insensitive substring test, PURE. */
export function ruleMatchesSearch(
  rule: RuleLike,
  query: string,
  triggerLabel: string | undefined,
  actionLabel: string | undefined,
  usedOn: readonly string[] = [],
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return ruleSearchText(rule, triggerLabel, actionLabel, usedOn).includes(needle);
}

/** A spec list's label for one id, or undefined when the id is not (yet) known. */
export function labelFor(specs: readonly SpecLike[], id: string): string | undefined {
  return specs.find((s) => s.id === id)?.label;
}
