// automation-param-validation.ts — is a trigger/condition/action's stored params
// good enough to run?
//
// PURE, and shared: the renderer imports this the same way it imports
// automation-triggers.ts's types, so the rule editor's live inline errors, the
// layout editor's inspector, and the server's save-time gate all read the exact
// same rule rather than three hand-copies drifting apart. See docs/automation.md.
//
// A number field is NEVER "missing" here: NumberInput cannot display a blank box,
// so an absent value reads as `spec.min ?? 0` — the same fallback ParamField and
// every provider's own `Number(params.x ?? 0)` already use. That is also why the
// "seed number defaults on pick" fix matters: before it, a freshly chosen step's
// number params were genuinely `undefined` in storage while the field displayed a
// default, so a required threshold could be saved unset and never fire.
//
// multi-enum is deliberately NEVER "required" here, regardless of `optional`. Every
// multi-enum in the registry today (`time.day-of-week`'s `days`,
// `pco.before-plan-time`'s `timeTypes`) treats a blank selection as "matches
// everything" — see the "Unconfigured means both" comment on the latter — so
// flagging a blank one as needing setup would mark every rule using the intended
// default as broken. Only a POPULATED-but-invalid multi-enum value is checked
// against a static option list.

import type { ParamDef } from "../types/automation.js";

export interface ParamIssue {
  key: string;
  message: string;
}

/** One field that needs setup, located within a rule. `index` is the condition's
 *  position in `rule.conditions`, present only when `step === "condition"` — a
 *  rule has exactly one trigger and one action, but any number of conditions. */
export interface RuleIssue extends ParamIssue {
  step: "trigger" | "condition" | "action";
  index?: number;
  /** The field's own label, prefixed with the condition's label when a rule has
   *  more than one condition — otherwise there is nothing to disambiguate. */
  label: string;
}

/** "1 field needs attention" / "4 fields need attention" — the rule editor's
 *  footer and the rules list's refusal toast share this exact wording. */
export function fieldsNeedAttention(n: number): string {
  return n === 1 ? "1 field needs attention" : `${n} fields need attention`;
}

/** Every number param's default, keyed by its own `min` (or 0) — what a fresh
 *  pick of a trigger/condition/action must seed immediately, so the field never
 *  displays a value it has not actually stored. See the module doc. */
export function seedNumberDefaults(specs: ParamDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of specs) {
    if (spec.type === "number") out[spec.key] = spec.min ?? 0;
  }
  return out;
}

/** A "key-value" param's stored JSON, as key/value pairs — [] for blank, null for
 *  text that is not a JSON object at all. A row with a blank key can never reach
 *  here: KeyValueField filters one out before it ever calls onChange, so "every
 *  row has a key" is enforced live, in KeyValueField itself, against rows nothing
 *  has committed yet — not against what this function is handed. */
function parseKeyValueRows(value: unknown): [string, string][] | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]);
  } catch {
    return null;
  }
}

/** The range a number must fall in, worded for an error message. */
function rangeSentence(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `Must be between ${min} and ${max}`;
  if (min !== undefined) return `Must be at least ${min}`;
  if (max !== undefined) return `Must be at most ${max}`;
  return "Must be a number";
}

/** "Required", or "Required — <help>" when the spec has one — every required
 *  string and missing required number share this wording. */
function requiredMessage(spec: ParamDef): string {
  return spec.help ? `Required — ${spec.help}` : "Required";
}

/**
 * PURE. One step's params against its own registry spec — a trigger's, a
 * condition's or an action's `params`, whichever the caller is validating.
 *
 * Returns one issue per bad field, in spec order. An optional field is never an
 * issue when it is empty; a field the spec does not list at all is never
 * inspected — an id this registry no longer has (a retired trigger, an action
 * renamed) is the caller's problem, not this function's, and it declines rather
 * than manufacturing issues against params it cannot interpret.
 */
export function validateParams(specs: ParamDef[], params: Record<string, unknown>): ParamIssue[] {
  const issues: ParamIssue[] = [];
  for (const spec of specs) {
    const value = params[spec.key];
    switch (spec.type) {
      case "string": {
        if (spec.optional) break;
        if (String(value ?? "").trim() !== "") break;
        issues.push({ key: spec.key, message: requiredMessage(spec) });
        break;
      }

      case "number": {
        const present = value !== undefined && value !== null && value !== "";
        if (!present) {
          if (spec.optional) break; // resolves to spec.min ?? 0, always in range
          issues.push({ key: spec.key, message: requiredMessage(spec) });
          break;
        }
        const n = Number(value);
        if (!Number.isFinite(n)) {
          issues.push({ key: spec.key, message: "Must be a number" });
          break;
        }
        if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
          issues.push({ key: spec.key, message: rangeSentence(spec.min, spec.max) });
        }
        break;
      }

      case "enum": {
        const current = String(value ?? "").trim();
        if (!current) {
          if (!spec.optional) issues.push({ key: spec.key, message: `Pick a ${spec.label.toLowerCase()}` });
          break;
        }
        // A RUNTIME list (optionsFrom) answering without the stored value is
        // never an issue — the value may simply be off right now (ProPresenter
        // unreachable, a target deleted since the rule was written). ParamField
        // shows the amber "no longer offered" note instead; see ParamField.
        if (spec.optionsFrom) break;
        if (spec.options && spec.options.length > 0 && !spec.options.some((o) => o.value === current)) {
          issues.push({ key: spec.key, message: `Pick a ${spec.label.toLowerCase()}` });
        }
        break;
      }

      case "multi-enum": {
        // Never "required" — see the module doc.
        const raw = String(value ?? "").trim();
        if (!raw || spec.optionsFrom) break;
        if (spec.options && spec.options.length > 0) {
          const picked = raw.split(",").map((v) => v.trim()).filter(Boolean);
          const bad = picked.some((v) => !spec.options!.some((o) => o.value === v));
          if (bad) issues.push({ key: spec.key, message: `Pick a ${spec.label.toLowerCase()}` });
        }
        break;
      }

      case "key-value": {
        const rows = parseKeyValueRows(value);
        if (rows === null) {
          issues.push({ key: spec.key, message: "This isn't a valid list" });
          break;
        }
        if (!spec.optional && rows.length === 0) {
          issues.push({ key: spec.key, message: `Add at least one ${(spec.keyLabel ?? "row").toLowerCase()}` });
        }
        break;
      }
    }
  }
  return issues;
}

/** One step's own label and params, as looked up from whichever registry shape
 *  the caller holds — the server's `Record<string, {label,params}>`, or the
 *  renderer's `Spec[]` arrays off `GET /api/automation/registry`. Returning null
 *  for an id the registry does not have is what lets `ruleIssues` skip a step an
 *  older release saved that this version no longer lists, exactly as the rule
 *  editor's own Selects already do. */
export type StepSpecLookup = (
  kind: "trigger" | "condition" | "action",
  id: string,
) => { label: string; params: ParamDef[] } | null;

/** The shape of one rule `ruleIssues` needs — just enough to walk its three
 *  kinds of step, so a caller can pass a full `Rule`, a `Partial<Rule>` merged
 *  onto an existing one, or a POST body being validated before it has an id. */
export interface RuleStepsLike {
  trigger: { id: string; params: Record<string, unknown> };
  conditions: { id: string; params: Record<string, unknown> }[];
  action: { id: string; params: Record<string, unknown> };
}

/**
 * PURE. Every field across a rule's trigger, conditions and action that needs
 * setup before the rule should run.
 *
 * Condition labels are prefixed with the condition's own label only when the
 * rule carries more than one — with zero or one there is nothing to
 * disambiguate, and a rule's trigger and action fields never need a prefix at
 * all: a rule has exactly one of each.
 */
export function ruleIssues(rule: RuleStepsLike, lookup: StepSpecLookup): RuleIssue[] {
  const out: RuleIssue[] = [];

  const trigger = lookup("trigger", rule.trigger.id);
  if (trigger) {
    for (const issue of validateParams(trigger.params, rule.trigger.params)) {
      out.push({ ...issue, step: "trigger", label: fieldLabel(trigger.params, issue.key) });
    }
  }

  const multipleConditions = rule.conditions.length > 1;
  rule.conditions.forEach((c, index) => {
    const condition = lookup("condition", c.id);
    if (!condition) return;
    for (const issue of validateParams(condition.params, c.params)) {
      const own = fieldLabel(condition.params, issue.key);
      out.push({
        ...issue,
        step: "condition",
        index,
        label: multipleConditions ? `${condition.label} · ${own}` : own,
      });
    }
  });

  const action = lookup("action", rule.action.id);
  if (action) {
    for (const issue of validateParams(action.params, rule.action.params)) {
      out.push({ ...issue, step: "action", label: fieldLabel(action.params, issue.key) });
    }
  }

  return out;
}

/** A field's own label, off its spec — falls back to the key when a spec is
 *  somehow missing it, which never happens for a real ParamDef but keeps this
 *  total rather than partial. */
function fieldLabel(specs: ParamDef[], key: string): string {
  return specs.find((s) => s.key === key)?.label ?? key;
}
