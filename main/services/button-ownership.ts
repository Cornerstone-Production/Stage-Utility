// button-ownership.ts — which Buttons use which cues, and which rules belong to a Button.
//
// A Button (`cue-button`) names a cue. A rule made FROM a Button carries
// `ownedBy: { viewId, objectId }` and exists for that Button alone. This module is
// the one place that walks the views for both questions:
//
//  - where is a cue used (`GET /api/cues/usage`)
//  - is this rule's Button still there (`ownerMissing` on the rules list, and the
//    one-line log when a save removes it)
//
// The walk is over `viewsStore`, Home included (Home is the view `"home"`), and
// recursive through containers. A view another view embeds is a view in its own
// right in the store, so each one is walked once, as itself; nothing is counted
// twice for being embedded.
//
// PURE but for `watchOwnedRules`, which subscribes to the views store. Nothing
// here is ever deleted: a rule whose Button is gone is KEPT and said so.

import type { OwnedBy, Rule } from "../types/automation.js";
import type { View } from "../types/stage.js";
import type { LayoutObject } from "../types/views.js";
import { CALL_TRIGGER_ID, calledCueName, parseAliases } from "./cue-aliases.js";
import { scrub } from "./scrub.js";
import { HOME_VIEW_ID } from "./home-view.js";
import { viewsStore } from "./views-store.js";
import { walkLayoutObjects } from "./view-refs.js";

/** One Button that names a cue. */
export interface CueButtonUse {
  viewId: string;
  viewName: string;
  objectId: string;
  /** The Button's own label; "" when it has none (it then draws the cue's name). */
  label: string;
  /** Whether the Button is on Home. */
  home: boolean;
}

/** Every Button under `objects`, nested ones included, with the cue it names, trimmed and
 *  lower-cased the way the engine compares a cue name. */
function cueButtonsIn(objects: readonly LayoutObject[] | undefined): { object: LayoutObject; cue: string }[] {
  const out: { object: LayoutObject; cue: string }[] = [];
  walkLayoutObjects(objects ?? [], (object) => {
    const cfg = object.config as { type?: string; cue?: unknown };
    if (cfg?.type === "cue-button" && typeof cfg.cue === "string" && cfg.cue.trim()) {
      out.push({ object, cue: cfg.cue.trim().toLowerCase() });
    }
  });
  return out;
}

/**
 * Every Button that names a cue, grouped by the cue it names, each list in a
 * fixed order (view id, then object id) so the answer is the same on every read.
 * The key is the cue as the engine reads it (trimmed, lower-case), which for a
 * pair is the pair's base.
 */
export function cueUsage(views: readonly View[]): Record<string, CueButtonUse[]> {
  // A Map, not an object built from stored text: a cue named `__proto__` in a
  // hand-edited layout must stay a key. Object.fromEntries defines, never assigns.
  const byCue = new Map<string, CueButtonUse[]>();
  for (const v of views) {
    for (const { object, cue } of cueButtonsIn(v.layout?.objects)) {
      const label = (object.config as { label?: unknown }).label;
      const use: CueButtonUse = {
        viewId: v.id,
        viewName: v.name,
        objectId: object.id,
        label: typeof label === "string" ? label : "",
        home: v.id === HOME_VIEW_ID,
      };
      const list = byCue.get(cue);
      if (list) list.push(use);
      else byCue.set(cue, [use]);
    }
  }
  const out: [string, CueButtonUse[]][] = [...byCue].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, list] of out) {
    list.sort((a, b) => a.viewId.localeCompare(b.viewId) || a.objectId.localeCompare(b.objectId));
  }
  return Object.fromEntries(out);
}

/** The names a Button may use to reach this rule: its cue name and its former names. */
function namesOf(rule: Rule): Set<string> {
  const names = new Set<string>(parseAliases(rule.trigger?.params));
  const name = calledCueName(rule.trigger);
  if (name) names.add(name);
  return names;
}

/**
 * Is this rule's Button still there: the object exists in that view, is a Button,
 * and names this rule's cue (or a former name of it)?
 *
 * A Button re-pointed at another cue is NOT its owner any more: the rule is then
 * treated exactly as one whose Button is gone — unless another Button still names
 * it. Duplicating a view copies its Buttons with their cue, so deleting the
 * original leaves the copy pressing the rule, and that rule's Button is not gone.
 */
export function ownerHolds(rule: Rule, views: readonly View[]): boolean {
  const owner = rule.ownedBy;
  if (!owner) return true;
  const names = namesOf(rule);
  const view = views.find((v) => v.id === owner.viewId);
  for (const { object, cue } of cueButtonsIn(view?.layout?.objects)) {
    if (object.id === owner.objectId && names.has(cue)) return true;
  }
  return views.some((v) => cueButtonsIn(v.layout?.objects).some(({ cue }) => names.has(cue)));
}

/**
 * The rules whose Button was there before a save and is not after it, each with
 * the name of the view it was on. A rule whose Button was never saved (written
 * when the pick was made, before the layout was) was not there before either, so
 * it is not reported.
 */
export function orphanedBetween(
  rules: readonly Rule[],
  before: readonly View[],
  after: readonly View[],
): { rule: Rule; viewName: string }[] {
  const out: { rule: Rule; viewName: string }[] = [];
  for (const rule of rules) {
    if (!rule.ownedBy) continue;
    if (!ownerHolds(rule, before) || ownerHolds(rule, after)) continue;
    const viewName = before.find((v) => v.id === rule.ownedBy!.viewId)?.name ?? rule.ownedBy.viewId;
    out.push({ rule, viewName });
  }
  return out;
}

/** The sentence logged once when a Button that owned a rule goes. */
export function orphanLine(rule: Rule, viewName: string): string {
  const name = calledCueName(rule.trigger) || rule.name;
  return `[automation] ${name} belongs to a button that is gone (${viewName}); kept, delete it from Automation`;
}

/**
 * Why a rule may not be saved owned, or null. Refused with a sentence rather than
 * stored: a Button is bound to a cue, so an owned rule on any other trigger would
 * leave its Button reading Not set.
 */
export function ownedByProblem(rule: { trigger?: { id?: string } | null; ownedBy?: unknown }): string | null {
  if (rule.ownedBy === undefined) return null;
  const o = rule.ownedBy as Partial<OwnedBy> | null;
  if (!o || typeof o !== "object" || typeof o.viewId !== "string" || !o.viewId || typeof o.objectId !== "string" || !o.objectId) {
    return "ownedBy needs a viewId and an objectId, both text";
  }
  if (rule.trigger?.id !== CALL_TRIGGER_ID) {
    return "A rule that belongs to a button has to stay Called by name, or the button would read Not set";
  }
  return null;
}

/**
 * Say, on the log, each rule whose Button a views save took away. Subscribed once,
 * by the engine; `getRules` reads the rules it holds NOW.
 *
 * The rule is kept. The line is the only thing that tells the operator it is
 * still there, and `ownerMissing` on the rules list is what the page reads.
 */
export function watchOwnedRules(getRules: () => readonly Rule[]): void {
  viewsStore.onSaved((previous, next) => {
    // The first write of a store nobody has read has no "before" to compare.
    if (!previous) return;
    for (const { rule, viewName } of orphanedBetween(getRules(), previous, next)) {
      console.log(scrub(orphanLine(rule, viewName)));
    }
  });
}
