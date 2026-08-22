// Drop the styling nobody chose off existing objects.
//
// Runs ONCE per install, recorded in settings — see stage-controller. It has to
// be once, because the file cannot say who wrote a value.
//
// There was a third of these, and it is why: it took the centre ALIGNMENT off
// every readout, since the registry wrote one into each object it created. But a
// centre the registry wrote and a centre the operator picked in the inspector
// are the same three characters, so running it every load deleted the operator's
// choice on every restart — which is every update, and it was reported exactly
// that way. That one is gone entirely; see readout-types.ts.
//
// What is left changes how a card OCCLUDES, which is a property of the widget
// rather than a preference. TWO of them, in one pass over one file rather than
// two walks and two writes:
//
//  1. the translucent card GROUND. Every preset ground was an rgba at 4-10%,
//     which does not occlude: a status widget over a transcript let the text
//     read straight through it, which looks exactly like the widget being drawn
//     underneath. Paint order was verified correct while that was happening —
//     the card was on top and 96% see-through. Each is swapped for the exact
//     blend of itself over the kiosk black, so a card is unchanged on a bare
//     canvas and now covers what is behind it.
//
//  2. the ELEVATED card. Objects created before the surface list was cut down
//     wear #191919 with a 10% hairline, while everything created since wears
//     #141414 with an 8% one. Both are cards; they are just cards from two
//     different years, and a layout built across both reads as some widgets
//     having a border and others not. Reported exactly that way. Folded into the
//     current card so a row of widgets looks like a row of widgets.
//
// Deliberately narrow, because this edits the operator's layouts: only the exact
// strings the registry wrote. A background an operator picked themselves is left
// alone.

import { opaqueGroundFor } from "../types/readout-types.js";
import type { LayoutObject, View } from "../types/views.js";

/**
 * The card the registry used to write, and the one it writes now.
 *
 * Matched as a PAIR: an object has to be wearing both the old ground and the old
 * hairline to be one of these. A #191919 somebody chose themselves, on anything
 * else, is not touched.
 */
const LEGACY_CARD = { background: "#191919", borderColor: "rgba(255,255,255,0.10)" } as const;
const CURRENT_CARD = { background: "#141414", borderColor: "rgba(255,255,255,0.08)" } as const;

function isLegacyCard(style: LayoutObject["style"]): boolean {
  return (
    (style?.background ?? "").replace(/\s+/g, "").toLowerCase() === LEGACY_CARD.background &&
    (style?.borderColor ?? "").replace(/\s+/g, "").toLowerCase() === LEGACY_CARD.borderColor
  );
}

/** Strip every never-chosen default from one object and its children.
 *  Returns the SAME object when nothing changed, so the caller can tell. */
function cleanObject(o: LayoutObject): LayoutObject {
  const kids = o.children?.map(cleanObject);
  const kidsChanged = kids != null && kids.some((k, i) => k !== o.children![i]);

  const opaque = opaqueGroundFor(o.style?.background);
  const oldCard = isLegacyCard(o.style);
  if (!opaque && !oldCard) {
    return kidsChanged ? { ...o, children: kids } : o;
  }
  const style = { ...o.style };
  if (opaque) style.background = opaque;
  if (oldCard) {
    style.background = CURRENT_CARD.background;
    style.borderColor = CURRENT_CARD.borderColor;
  }
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
export function migrateNeverChosenDefaults(views: readonly View[]): View[] {
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
 *  an operator whose layouts moved can find out why rather than guessing.
 *  Counts an object ONCE however many of its defaults are being replaced. */
export function countNeverChosen(views: readonly View[]): number {
  let n = 0;
  const walk = (objs: readonly LayoutObject[] | undefined) => {
    for (const o of objs ?? []) {
      if (opaqueGroundFor(o.style?.background) || isLegacyCard(o.style)) n++;
      walk(o.children);
    }
  };
  for (const v of views) walk(v.layout?.objects);
  return n;
}
