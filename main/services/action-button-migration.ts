// action-button-migration.ts — every Run an action Button becomes a cue Button.
//
// A Button set to Run an action (`action-button`) called `invokeAction` directly and
// so ignored Simulate, Disarm, the cooldown and the service guard, while a Button
// set to Fire a cue obeyed all of them. Every press is a cue now. This is the pass
// that turns the old Buttons into the new ones, once, at start-up.
//
// Each `action-button`, in every view (Home and the console views included, nested
// objects included), becomes a `cue-button` with the same label, position, look and
// style, bound to a NEW rule that belongs to it (`ownedBy`) and carries the stored
// action id and params. An action id the registry no longer has still migrates: the
// rule editor shows an unknown action rather than dropping it, and dropping it here
// would lose what the operator had.
//
// The migration changes behaviour on purpose: those Buttons now obey Simulate and
// Disarm.
//
// A view that arrives later (an import) is converted the same way, by the same
// function, so no Button ever keeps ignoring Simulate and Disarm.
//
// `planActionButtonMigration` is PURE: it plans. `runActionButtonMigration` writes
// the rules and hands the views back for the caller to save (stage-controller.ts,
// in the pass that already owns the views file). A pass that died between its two
// writes is safe to run again: a Button whose rule is already there (same
// `ownedBy`) is bound to that rule rather than given a second.

import { randomUUID } from "node:crypto";

import type { Rule } from "../types/automation.js";
import type { View } from "../types/stage.js";
import type { LayoutObject } from "../types/views.js";
import { calledCueName } from "./cue-aliases.js";
import { buttonCueRule, chosenLabel, cueNameFor, cueSlug, namesTakenForNewCue, ruleParams } from "./cue-naming.js";
import { migrateViews } from "./never-chosen-defaults.js";
import { automationStore } from "./automation-store.js";
import { errorMessage } from "./errors.js";
import { plural } from "./plural.js";
import { scrub } from "./scrub.js";
import { viewsStore } from "./views-store.js";

/**
 * What a Run an action Button was stored as. The type is gone from the config union
 * (nothing makes one any more), but a layout saved before it went, or an import of
 * one, still holds them, and this pass is what turns each into a Button of the one
 * kind. Read from stored JSON, so every field is checked as it is used.
 */
interface StoredActionButton {
  type: "action-button";
  actionId: string;
  params?: Record<string, unknown>;
  label?: string;
}

const isStoredActionButton = (cfg: unknown): cfg is StoredActionButton =>
  (cfg as { type?: unknown } | null | undefined)?.type === "action-button";

/** What the pass would do. */
export interface ActionButtonMigration {
  /** The views after the pass; the SAME array when nothing changed. */
  views: View[];
  /** The rules to add, each belonging to one Button. Empty when every Button already has its rule. */
  rules: Rule[];
  /** How many Buttons were converted, rules already there included. */
  count: number;
  /** How many of those per view name, in the order the views appear. */
  perView: { viewName: string; count: number }[];
}

/**
 * Plan the migration of every Run an action Button in `views`.
 *
 * `actionLabel` is the registry's name for an action id, which names the rule of a
 * Button with no label of its own; undefined for an id the registry does not have.
 */
export function planActionButtonMigration(
  views: readonly View[],
  existingRules: readonly Rule[],
  actionLabel: (actionId: string) => string | undefined,
): ActionButtonMigration {
  const taken = namesTakenForNewCue(existingRules);
  // The same Button, found again by a pass that died before it finished.
  const ownedAlready = new Map<string, string>();
  for (const r of existingRules) {
    // A hand-edited owned rule with no cue name binds nothing: it is not "already there".
    const name = r.ownedBy ? calledCueName(r.trigger) : "";
    if (r.ownedBy && name) ownedAlready.set(`${r.ownedBy.viewId}\n${r.ownedBy.objectId}`, name);
  }

  const rules: Rule[] = [];
  // By view id: names are not unique, and two views called "Console" are two entries.
  const perView = new Map<string, { viewName: string; count: number }>();
  let count = 0;

  // Returns `o` itself when nothing under it changed, which is what migrateViews
  // reads as "this view is untouched".
  const convert = (o: LayoutObject, view: View): LayoutObject => {
    let next = o;
    const cfg: unknown = o.config;
    if (isStoredActionButton(cfg)) {
      const known = ownedAlready.get(`${view.id}\n${o.id}`);
      const label = chosenLabel(cfg.label);
      const registryName = actionLabel(cfg.actionId)?.trim() || cfg.actionId;
      // The rule is read by an operator in a list: the label the Button wears, or
      // the action's own name. The cue is named from the same, unless the label
      // has no letters in it.
      const ruleName = label ?? registryName;
      let cueName = known;
      if (cueName === undefined) {
        cueName = cueNameFor(cueSlug(ruleName) ? ruleName : registryName, taken, "btn_");
        taken.add(cueName);
        rules.push({
          ...buttonCueRule({
            name: ruleName,
            cueName,
            action: { id: cfg.actionId, params: ruleParams(cfg.params) },
            ownedBy: { viewId: view.id, objectId: o.id },
          }),
          id: randomUUID(),
        });
      }
      next = {
        ...o,
        config: { type: "cue-button", cue: cueName, ...(typeof cfg.label === "string" ? { label: cfg.label } : {}) },
      };
      count++;
      const entry = perView.get(view.id);
      if (entry) entry.count++;
      else perView.set(view.id, { viewName: view.name, count: 1 });
    }
    if (o.children?.length) {
      // Embedded views are separate entries in the store, reached by the outer
      // loop; this recursion is for objects nested inside a container.
      const kids = o.children.map((c) => convert(c, view));
      if (kids.some((k, i) => k !== o.children![i])) next = { ...next, children: kids };
    }
    return next;
  };

  const out = migrateViews(views, convert);
  return { views: out, rules, count, perView: [...perView.values()] };
}

/** The one line a run logs, or null when there was nothing to migrate. */
export function migrationLine(m: Pick<ActionButtonMigration, "count" | "perView">, via: boolean | "save" = false): string | null {
  if (m.count === 0) return null;
  const where = m.perView.map((p) => `${scrub(p.viewName)} ${p.count}`).join(", ");
  const what = m.count === 1 ? "1 Run an action button to its own cue" : `${m.count} Run an action buttons to their own cues`;
  const arrived = via === "save" ? " on save" : via ? " on import" : "";
  return `[automation] ${via ? "converted" : "migrated"} ${what}${arrived} (${where})`;
}

/** What the pass reads and writes, so a test can swap any of it. */
export interface ActionButtonMigrationDeps {
  loadRules(): Promise<Rule[]>;
  saveRules(rules: Rule[]): Promise<void>;
  /** Why the rules or the views would refuse a save, or null. */
  refusal(): Error | null;
  /** The registry's name for an action id. */
  actionLabel(actionId: string): string | undefined;
}

/** What one run did. */
export interface ActionButtonMigrationRun {
  /** The views to save: the SAME array when nothing changed. */
  views: View[];
  /** How many new rules this run wrote. The caller says so when saving the views then fails. */
  rulesWritten: number;
  /** The cue names of those rules, for a caller that has to say which were kept. */
  cuesWritten: string[];
  /** What to log on success, or null. */
  line: string | null;
  /** What to log as an error, or null: why the Buttons were left alone. */
  failure: string | null;
}

async function defaultDeps(): Promise<ActionButtonMigrationDeps> {
  // Lazily: the action registry reaches back into the stage controller, which calls this.
  const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
  return {
    loadRules: () => automationStore.loadRules(),
    saveRules: (rules) => automationStore.saveRules(rules),
    refusal: () => automationStore.refusingSaves() ?? viewsStore.refusingSaves(),
    actionLabel: (id) => AUTOMATION_ACTIONS[id]?.label,
  };
}

/**
 * The same deps over the RUNNING engine, for a pass made while the server is up. Rules written
 * straight to the store would not be in the engine until the next start, and a Button bound to
 * a cue the engine does not know refuses every press. New rules go through `addRule`, which
 * gives each its id; the cue names the Buttons keep are the plan's own.
 */
export async function liveRulesDeps(): Promise<ActionButtonMigrationDeps> {
  const { automationEngine } = await import("./automation-engine.js");
  return {
    ...(await defaultDeps()),
    loadRules: async () => automationEngine.listRules(),
    saveRules: async (all) => {
      const known = new Set(automationEngine.listRules().map((r) => r.id));
      for (const { id, ...rule } of all) if (!known.has(id)) await automationEngine.addRule(rule);
    },
  };
}

/**
 * The whole pass over the views the controller holds: plan, write the new rules,
 * return the views. Writes the RULES and not the views, so the two writes are told
 * apart.
 *
 * Runs at every start, on import and on a layout save; with nothing to convert it writes and says
 * nothing. A failure is returned as `failure`, never swallowed into "done": the
 * next start tries again over the same Buttons, which until then draw "Needs
 * converting" and do nothing (the app has no renderer that presses one).
 */
export async function runActionButtonMigration(
  views: View[],
  opts: {
    /** Views arriving through an import rather than the start-up pass: worded as such on the log. */
    onImport?: boolean;
    /** A layout saved by the editor (an older tab can send the type back): worded as such. */
    onSave?: boolean;
    deps?: ActionButtonMigrationDeps;
  } = {},
): Promise<ActionButtonMigrationRun> {
  const left = (failure: string | null): ActionButtonMigrationRun => ({ views, rulesWritten: 0, cuesWritten: [], line: null, failure });
  const d = opts.deps ?? (await defaultDeps());
  let existing: Rule[];
  try {
    existing = await d.loadRules();
  } catch (err) {
    return left(refusedSentence(err));
  }
  // After the load, not before: a store that has not been read yet cannot say it
  // is unreadable, and an unreadable rules file reads as no rules at all. Writing
  // over that is how an operator's cues are lost, so nothing is changed until a
  // start reads it.
  const refusal = d.refusal();
  if (refusal) return left(refusedSentence(refusal));
  const plan = planActionButtonMigration(views, existing, d.actionLabel);
  if (plan.count === 0) return left(null);
  if (plan.rules.length > 0) {
    try {
      await d.saveRules([...existing, ...plan.rules]);
    } catch (err) {
      return left(
        `[automation] ${plural(plan.count, "Run an action button")} were not converted: the cues could not be saved (${errorMessage(err)}). ` +
          "They show Needs converting and do nothing until the next start converts them.",
      );
    }
  }
  return { views: plan.views, rulesWritten: plan.rules.length, cuesWritten: plan.rules.map((r) => String(r.trigger.params.name)), line: migrationLine(plan, opts.onSave ? "save" : opts.onImport), failure: null };
}

function refusedSentence(why: unknown): string {
  return `[automation] Run an action buttons were not converted: ${errorMessage(why)}. They show Needs converting and do nothing until the next start that reads it converts them.`;
}
