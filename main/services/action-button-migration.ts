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
// PURE: it plans, and the caller writes (stage-controller.ts, in the pass that
// already owns the views file). A pass that died between its two writes is safe to
// run again: a Button whose rule is already there (same `ownedBy`) is bound to that
// rule rather than given a second.

import { randomUUID } from "node:crypto";

import type { Rule } from "../types/automation.js";
import type { View } from "../types/stage.js";
import type { LayoutObject } from "../types/views.js";
import { ownedCueRule } from "./button-ownership.js";
import { calledCueName, takenCueNames } from "./cue-aliases.js";
import { chosenLabel, cueNameFor, cueSlug } from "./cue-naming.js";
import { scrub } from "./scrub.js";

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

/** Rule params hold strings and numbers only, and so does every registry param. */
function ruleParams(params: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}

/** Whether any object under `objects`, nested ones included, is an action-button. */
function hasActionButton(objects: readonly LayoutObject[] | undefined): boolean {
  return (objects ?? []).some((o) => o.config?.type === "action-button" || hasActionButton(o.children));
}

/** How many Run an action Buttons these views hold. For the caller's "nothing to do" check. */
export function countActionButtons(views: readonly View[]): number {
  let n = 0;
  const walk = (objects: readonly LayoutObject[] | undefined) => {
    for (const o of objects ?? []) {
      if (o.config?.type === "action-button") n++;
      walk(o.children);
    }
  };
  for (const v of views) walk(v.layout?.objects);
  return n;
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
  // Everything a cue name may not be, and a pair's base as well as its two halves:
  // the manifest lists a pair under its base, so `btn_x` would collide with the
  // pair `btn_x_on` / `btn_x_off`.
  const taken = takenCueNames(existingRules);
  for (const name of [...taken]) {
    const base = /^(.+)_(on|off)$/.exec(name)?.[1];
    if (base) taken.add(base);
  }
  // The same Button, found again by a pass that died before it finished.
  const ownedAlready = new Map<string, string>();
  for (const r of existingRules) {
    // A hand-edited owned rule with no cue name binds nothing: it is not "already there".
    const name = r.ownedBy ? calledCueName(r.trigger) : "";
    if (r.ownedBy && name) ownedAlready.set(`${r.ownedBy.viewId}\n${r.ownedBy.objectId}`, name);
  }

  const rules: Rule[] = [];
  const perView: { viewName: string; count: number }[] = [];
  let count = 0;
  let changedAny = false;

  const convert = (view: View, objects: readonly LayoutObject[]): LayoutObject[] | null => {
    if (!hasActionButton(objects)) return null;
    return objects.map((o) => {
      let next = o;
      const cfg = o.config;
      if (cfg?.type === "action-button") {
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
            ...ownedCueRule({
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
        const entry = perView.find((p) => p.viewName === view.name);
        if (entry) entry.count++;
        else perView.push({ viewName: view.name, count: 1 });
      }
      if (o.children?.length) {
        // Embedded views are separate entries in the store, reached by the outer
        // loop; this recursion is for objects nested inside a container.
        const kids = convert(view, o.children);
        if (kids) next = { ...next, children: kids };
      }
      return next;
    });
  };

  const out = views.map((v) => {
    const objects = v.layout?.objects;
    if (!objects?.length) return v;
    const converted = convert(v, objects);
    if (!converted) return v;
    changedAny = true;
    return { ...v, layout: { ...v.layout!, objects: converted } };
  });

  return { views: changedAny ? out : (views as View[]), rules, count, perView };
}

/** The one line a run logs, or null when there was nothing to migrate. */
export function migrationLine(m: Pick<ActionButtonMigration, "count" | "perView">): string | null {
  if (m.count === 0) return null;
  const where = m.perView.map((p) => `${scrub(p.viewName)} ${p.count}`).join(", ");
  const what = m.count === 1 ? "1 Run an action button to its own cue" : `${m.count} Run an action buttons to their own cues`;
  return `[automation] migrated ${what} (${where})`;
}
