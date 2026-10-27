// new-cue-flow.ts — the New cue dialog's model: its steps, its defaults, what a
// step needs before Next, and the rule Create writes.
//
// PURE: the dialog draws from this and decides nothing itself, so every default
// and every rule about what a cue is can be tested without a DOM.
//
// A CUE IS EITHER OF TWO THINGS and the steps follow from which:
//
//  - MANUAL. Fires only when somebody fires it — its Run button, a cue button on a
//    console, Home Assistant or voice. Stored as the existing Called by name
//    trigger, so every one of those keeps working. It never fires by itself, so it
//    starts ON.
//  - AUTOMATIC. Fires when something happens in the building. It starts OFF: the
//    advice the Review step gives is to watch it with a log message first.
//
// NOTHING IS SAVED UNTIL CREATE. The draft lives in the dialog and goes with it.

import { CALL_TRIGGER_ID } from "@main/services/cue-aliases";
import { deriveCueName } from "@main/services/cue-name";
import { homeVisibilityParams } from "@main/services/cue-pairs";
import { ruleIssues, type RuleIssue } from "@main/services/automation-param-validation";
import { withServiceGuard } from "@main/services/service-guard";
import type { Rule } from "@main/types/automation";
import { specLookupFor, type Registry } from "./rule-editor-dialog";

export type CueKind = "manual" | "auto";

export type StepId = "kind" | "trig" | "if" | "act" | "name" | "console" | "review";

export interface Step {
  id: StepId;
  label: string;
  /** Can be skipped: it needs nothing to move on, and Skip says so. */
  optional?: boolean;
}

const KIND: Step = { id: "kind", label: "Kind" };
const REVIEW: Step = { id: "review", label: "Review" };

export const MANUAL_STEPS: readonly Step[] = [
  KIND,
  { id: "act", label: "What it does" },
  { id: "name", label: "Name and where it fires" },
  { id: "console", label: "On a console", optional: true },
  REVIEW,
];

export const AUTO_STEPS: readonly Step[] = [
  KIND,
  { id: "trig", label: "When" },
  { id: "if", label: "If", optional: true },
  { id: "act", label: "Then" },
  { id: "name", label: "Name and safety" },
  REVIEW,
];

/** The steps for a kind; just the first until one is chosen. */
export function stepsFor(kind: CueKind | null): readonly Step[] {
  switch (kind) {
    case "manual":
      return MANUAL_STEPS;
    case "auto":
      return AUTO_STEPS;
    case null:
      return [KIND];
  }
}

/** A manual cue is followed by a person pressing a button; two seconds stops a
 *  double press. An automatic rule can oscillate across a threshold. */
export const MANUAL_COOLDOWN_SEC = 2;
export const AUTO_COOLDOWN_SEC = 30;

interface StepValue {
  id: string;
  params: Record<string, string | number>;
}

export interface CueDraft {
  kind: CueKind | null;
  /** Automatic only. */
  trigger: StepValue;
  conditions: StepValue[];
  action: StepValue;
  /** What the operator typed. Blank uses the suggestion. */
  name: string;
  /** Manual only: whether Home Assistant gets an entity for it. */
  homeAssistant: boolean;
  /** Manual only: whether it may fire while a service is live. */
  allowedDuringService: boolean;
  /** Null until the operator sets it: the kind's own default. */
  cooldownSec: number | null;
  oncePerService: boolean;
  /** Null until the operator sets it: manual ON, automatic OFF. */
  enabled: boolean | null;
  /** Manual only: the consoles to put a button on, by view id. */
  consoleIds: string[];
  /** The label on those buttons. Blank uses the cue's name. */
  buttonLabel: string;
}

/** A fresh draft. `kind` is preset when the dialog is opened from a link that
 *  already says which. */
export function emptyDraft(kind: CueKind | null = null): CueDraft {
  return {
    kind,
    trigger: { id: "", params: {} },
    conditions: [],
    action: { id: "", params: {} },
    name: "",
    homeAssistant: false,
    allowedDuringService: true,
    cooldownSec: null,
    oncePerService: false,
    enabled: null,
    consoleIds: [],
    buttonLabel: "",
  };
}

export const enabledOf = (d: CueDraft): boolean => d.enabled ?? d.kind === "manual";

export const cooldownOf = (d: CueDraft): number =>
  d.cooldownSec ?? (d.kind === "manual" ? MANUAL_COOLDOWN_SEC : AUTO_COOLDOWN_SEC);

export const labelOf = (list: readonly { id: string; label: string }[], id: string): string =>
  list.find((x) => x.id === id)?.label ?? "";

/** What the Name field offers when it is blank: the action for a manual cue,
 *  "<when> → <then>" for an automatic one. */
export function suggestedName(d: CueDraft, registry: Registry): string {
  const action = labelOf(registry.actions, d.action.id);
  if (d.kind === "manual") return action;
  const trigger = labelOf(registry.triggers, d.trigger.id);
  return trigger && action ? `${trigger} → ${action}` : "";
}

/** The rule's name: what was typed, or the suggestion. */
export const displayName = (d: CueDraft, registry: Registry): string =>
  d.name.trim() || suggestedName(d, registry);

/** The cue name a manual cue is made with: from its display name, not taken. */
export function newCueName(d: CueDraft, registry: Registry, taken: ReadonlySet<string>): string {
  return deriveCueName(displayName(d, registry), taken);
}

/**
 * The draft's parts as a rule's own validator reads them — the SAME check the
 * editor's Needs setup runs, so a step cannot be passed that the editor would
 * then mark. A step with no id yet has no issues of its own; whether it is
 * chosen is {@link stepComplete}'s question.
 */
function draftIssues(d: CueDraft, registry: Registry): RuleIssue[] {
  return ruleIssues(
    {
      trigger: d.kind === "manual" ? { id: "", params: {} } : d.trigger,
      conditions: d.conditions,
      action: d.action,
    },
    specLookupFor(registry),
  );
}

/** The rule step each flow step edits; the others edit none. */
const STEP_KIND: Partial<Record<StepId, RuleIssue["step"]>> = { trig: "trigger", if: "condition", act: "action" };

/** Fields that still need filling on one step, by their labels. */
export function stepIssues(id: StepId, d: CueDraft, registry: Registry): RuleIssue[] {
  const want = STEP_KIND[id];
  return want ? draftIssues(d, registry).filter((i) => i.step === want) : [];
}

/** May the operator move past this step? The first four need a choice and its
 *  required fields; the rest need nothing. */
export function stepComplete(id: StepId, d: CueDraft, registry: Registry): boolean {
  switch (id) {
    case "kind":
      return d.kind !== null;
    case "trig":
      return d.trigger.id !== "" && stepIssues("trig", d, registry).length === 0;
    case "if":
      return stepIssues("if", d, registry).length === 0;
    case "act":
      return d.action.id !== "" && stepIssues("act", d, registry).length === 0;
    default:
      return true;
  }
}

/** Is every step before `index` complete? What lets the stepper go straight to a
 *  later step, and nothing earlier than it. */
export function reachable(index: number, d: CueDraft, registry: Registry): boolean {
  return stepsFor(d.kind)
    .slice(0, index)
    .every((s) => stepComplete(s.id, d, registry));
}

/**
 * The rule Create writes.
 *
 * A manual cue is the Called by name trigger with its cue name derived from the
 * display name, Home Assistant off unless asked for (it is shown by default only
 * on the cues Companion imports), and the service guard on unless it is allowed
 * during a service. An automatic rule is what the steps chose, as they chose it.
 */
export function buildRule(d: CueDraft, registry: Registry, taken: ReadonlySet<string>): Omit<Rule, "id"> {
  const name = displayName(d, registry);
  if (d.kind === "manual") {
    return {
      name,
      enabled: enabledOf(d),
      trigger: {
        id: CALL_TRIGGER_ID,
        params: { name: newCueName(d, registry, taken), ...homeVisibilityParams(!d.homeAssistant) },
      },
      conditions: withServiceGuard([], !d.allowedDuringService),
      action: d.action,
      cooldownSec: cooldownOf(d),
      oncePerService: false,
    };
  }
  return {
    name,
    enabled: enabledOf(d),
    trigger: d.trigger,
    conditions: d.conditions,
    action: d.action,
    cooldownSec: cooldownOf(d),
    oncePerService: d.oncePerService,
  };
}
