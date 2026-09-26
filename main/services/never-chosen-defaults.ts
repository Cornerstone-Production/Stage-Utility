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
//     #141414. Both are cards; they are just cards from two different years, and
//     a layout built across both reads as some widgets having a border and
//     others not. Reported exactly that way. Folded into the current card —
//     #141414 and CARD_HAIRLINE, the registry's own — so a row of widgets looks
//     like a row of widgets.
//
// A second pass, with its own once-flag, moves every 8% hairline to
// CARD_HAIRLINE: the registry and the templates wrote 8% for a while, and so did
// the first pass above, into every card it folded. See migrateCardHairline.
//
// Deliberately narrow, because this edits the operator's layouts: only the exact
// strings the registry wrote. A background an operator picked themselves is left
// alone.

import { CARD_HAIRLINE, opaqueGroundFor } from "../types/readout-types.js";
import type { LayoutObject, View } from "../types/views.js";

/**
 * The card the registry used to write, and the one it writes now.
 *
 * Matched as a PAIR: an object has to be wearing both the old ground and the old
 * hairline to be one of these. A #191919 somebody chose themselves, on anything
 * else, is not touched.
 */
const LEGACY_CARD = { background: "#191919", borderColor: "rgba(255,255,255,0.10)" } as const;
const CURRENT_CARD = { background: "#141414", borderColor: CARD_HAIRLINE } as const;

function isLegacyCard(style: LayoutObject["style"]): boolean {
  return (
    (style?.background ?? "").replace(/\s+/g, "").toLowerCase() === LEGACY_CARD.background &&
    (style?.borderColor ?? "").replace(/\s+/g, "").toLowerCase() === LEGACY_CARD.borderColor
  );
}

/**
 * Walk one object and its children bottom-up, asking `transformStyle` for each
 * one's replacement style. `null` means "leave this object's style alone".
 *
 * Shared by both passes below so the reference-preserving walk — the part a
 * test asserts on directly — exists once rather than twice in a file that is
 * already explicit about not wanting two walks over the same tree.
 *
 * Returns the SAME object when nothing in it or its children changed.
 */
function mapObjectStyle(
  o: LayoutObject,
  transformStyle: (style: LayoutObject["style"]) => LayoutObject["style"] | null,
): LayoutObject {
  const kids = o.children?.map((k) => mapObjectStyle(k, transformStyle));
  const kidsChanged = kids != null && kids.some((k, i) => k !== o.children![i]);
  const style = transformStyle(o.style);
  if (style == null) return kidsChanged ? { ...o, children: kids } : o;
  return { ...o, style, ...(kidsChanged ? { children: kids } : null) };
}

/** Strip every never-chosen default from one object and its children. */
function cleanObject(o: LayoutObject): LayoutObject {
  return mapObjectStyle(o, (style) => {
    const opaque = opaqueGroundFor(style?.background);
    const oldCard = isLegacyCard(style);
    if (!opaque && !oldCard) return null;
    const next = { ...style };
    if (opaque) next.background = opaque;
    if (oldCard) {
      next.background = CURRENT_CARD.background;
      next.borderColor = CURRENT_CARD.borderColor;
    }
    return next;
  });
}

/**
 * Run an object-level migration over every view.
 *
 * Shared by both passes below. Returns the views array BY REFERENCE when
 * nothing changed, so a load that has already been migrated skips the write
 * entirely — a fresh array every launch is a file rewrite for nothing, and
 * this runs beside another migration that shares the same file.
 */
function migrateViews(views: readonly View[], transformObject: (o: LayoutObject) => LayoutObject): View[] {
  let changed = false;
  const out = views.map((v) => {
    const objects = v.layout?.objects;
    if (!objects?.length) return v;
    const transformed = objects.map(transformObject);
    if (!transformed.some((o, i) => o !== objects[i])) return v;
    changed = true;
    return { ...v, layout: { ...v.layout!, objects: transformed } };
  });
  return changed ? out : (views as View[]);
}

/** How many objects in a view tree match `matches` — for a load-time log line,
 *  so an operator whose layouts moved can find out why rather than guessing.
 *  Counts an object ONCE however many of its defaults are being replaced. */
function countMatching(views: readonly View[], matches: (style: LayoutObject["style"]) => boolean): number {
  let n = 0;
  const walk = (objs: readonly LayoutObject[] | undefined) => {
    for (const o of objs ?? []) {
      if (matches(o.style)) n++;
      walk(o.children);
    }
  };
  for (const v of views) walk(v.layout?.objects);
  return n;
}

export function migrateNeverChosenDefaults(views: readonly View[]): View[] {
  return migrateViews(views, cleanObject);
}

export function countNeverChosen(views: readonly View[]): number {
  return countMatching(views, (style) => Boolean(opaqueGroundFor(style?.background) || isLegacyCard(style)));
}

/** The hairline the registry, the templates and the first pass above wrote
 *  before every card border became CARD_HAIRLINE. */
const FAINT_HAIRLINE = "rgba(255,255,255,0.08)";

function hasFaintHairline(style: LayoutObject["style"]): boolean {
  return (style?.borderColor ?? "").replace(/\s+/g, "").toLowerCase() === FAINT_HAIRLINE;
}

/**
 * Give every object wearing the old 8% hairline the card border new widgets
 * get, on any ground. Runs once, like the pass above, and for the same reason:
 * after it has run, an 8% border is one the operator picked.
 */
export function migrateCardHairline(views: readonly View[]): View[] {
  return migrateViews(views, (o) =>
    mapObjectStyle(o, (style) => (hasFaintHairline(style) ? { ...style, borderColor: CARD_HAIRLINE } : null)),
  );
}

/** How many objects migrateCardHairline would change, for its log line. */
export function countFaintHairlines(views: readonly View[]): number {
  return countMatching(views, hasFaintHairline);
}
