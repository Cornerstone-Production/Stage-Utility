// Drop the centre alignment nobody chose off existing readouts.
//
// Every style preset in the object registry spreads TEXT(), which writes
// `textAlign: "center"`. So every readout ever created stored a centre
// alignment as a side effect of being created — 24 of them across four real
// views, and not one of them a decision anybody made.
//
// That made the widget idiom's left-aligned composition impossible to have as a
// DEFAULT without ignoring the field outright, which is what the first cut did
// — and ignoring it meant a custom view could never centre a widget on purpose.
//
// So the never-chosen value comes off once, here. After this runs, whatever is
// stored IS a choice, the default is left, and the control works again.
//
// Deliberately narrow, because this edits the operator's layouts: only readout
// types, and only the exact string the registry wrote. An object already set to
// `right`, or to `center` on a type this does not cover, is left alone.

import { isNeverChosenAlign } from "../types/readout-types.js";
import type { LayoutObject, View } from "../types/views.js";

/** Strip the never-chosen alignment from one object and its children.
 *  Returns the SAME object when nothing changed, so the caller can tell. */
function cleanObject(o: LayoutObject): LayoutObject {
  const kids = o.children?.map(cleanObject);
  const kidsChanged = kids != null && kids.some((k, i) => k !== o.children![i]);

  if (!isNeverChosenAlign(o.config.type, o.style)) {
    return kidsChanged ? { ...o, children: kids } : o;
  }
  const { textAlign: _neverChosen, ...style } = o.style!;
  return { ...o, style, ...(kidsChanged ? { children: kids } : null) };
}

/**
 * Run the migration over every view.
 *
 * Returns the views array BY REFERENCE when nothing changed, so a load that has
 * already been migrated skips the write entirely — a fresh array every launch is
 * a file rewrite for nothing, and this runs beside two other migrations that
 * share the same file.
 */
export function migrateReadoutAlign(views: readonly View[]): View[] {
  let changed = false;
  const out = views.map((v) => {
    const objects = v.layout?.objects;
    if (!objects?.length) return v;
    const cleaned = objects.map(cleanObject);
    if (!cleaned.some((o, i) => o !== objects[i])) return v;
    changed = true;
    return { ...v, layout: { ...v.layout!, objects: cleaned } };
  });
  return changed ? out : (views as View[]);
}

/** How many objects the migration would touch — for the load-time log line, so
 *  an operator whose layouts moved can find out why rather than guessing. */
export function countNeverChosenAlign(views: readonly View[]): number {
  let n = 0;
  const walk = (objs: readonly LayoutObject[] | undefined) => {
    for (const o of objs ?? []) {
      if (isNeverChosenAlign(o.config.type, o.style)) n++;
      walk(o.children);
    }
  };
  for (const v of views) walk(v.layout?.objects);
  return n;
}
