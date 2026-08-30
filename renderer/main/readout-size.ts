// How the one widget idiom sizes itself: caption, value and sub-line derived
// from the widget's own height.
//
// Pure arithmetic, separate from the component that renders it, so the
// proportions can be asserted without a DOM. The composition is the part of this
// change that is structural rather than cosmetic — it is what makes a readout
// legible at whatever size it is placed at — so it gets tests.

/**
 * The value's share of the widget's height WHEN the composition has all three
 * lines — caption, value and sub.
 *
 * PROVISIONAL, and deliberately THE one named constant so tuning is one edit.
 *
 * The comparison page this idiom was approved from used 0.30, and the approval
 * came with the caveat that it probably wants raising — a clock especially. A
 * static page at two chosen sizes cannot settle it: the number that matters is
 * how it reads on a real wall from across the room, and against a real tile on
 * Home. Tune it there, on real screens, not in a mockup.
 */
export const VALUE_SCALE = 0.3;

/** The caption's and sub-line's share of the same height, with pixel floors so
 *  neither disappears in a small tile — a caption that cannot be read is
 *  decoration, which is the bug the fit-to-fill readouts had. */
export const CAPTION_SCALE = 0.105;
export const CAPTION_MIN_PX = 9;
export const SUB_SCALE = 0.115;
export const SUB_MIN_PX = 10;

/** The gap between lines, box-relative so the composition holds its proportions
 *  rather than crowding one end at a wall size. */
export const GAP_SCALE = 0.03;

/**
 * The idiom's own padding, as a share of the box.
 *
 * The composition supplies this instead of the object's stored `padding`, which
 * is a fraction of the CANVAS: at 1080 tall a preset pill carries 14.7px on every
 * side, which is fine in a big widget and catastrophic in a small one. A 54px
 * status pill was left 23px of content for a 31px composition and clipped its own
 * value — the size of the padding had nothing to do with the size of the widget.
 *
 * That is the same "accident of the box" this task exists to remove, so the
 * readout draws over the object's padding and applies this instead. Horizontal
 * padding is capped against the WIDTH: a tall narrow widget would otherwise take
 * more side padding than it has width.
 */
export const PAD_SCALE = 0.11;

/** Line heights. Exported because the budget below counts them, and because the
 *  rendered leading must be the same number the budget spent. */
export const CAPTION_LEADING = 1.1;
export const VALUE_LEADING = 1.05;
export const SUB_LEADING = 1.2;

/** Below this share of the box the value stops shrinking, however little budget
 *  the caption and sub-line have left it. */
const VALUE_FLOOR_SCALE = 0.18;

/**
 * What the whole composition may occupy, as a share of the box.
 *
 * DERIVED from VALUE_SCALE rather than picked, so that constant stays the single
 * knob: this is exactly what the approved three-line composition adds up to.
 * Raising VALUE_SCALE therefore raises the budget, and every line count grows
 * with it — which is what "put the ratio in one named constant" has to mean if
 * the constant is to be tunable at all. A hard-coded budget would cap the value
 * however high the constant was set.
 */
export const CONTENT_SCALE =
  VALUE_SCALE * VALUE_LEADING +
  CAPTION_SCALE * CAPTION_LEADING +
  SUB_SCALE * SUB_LEADING +
  2 * GAP_SCALE;

/**
 * The value gets whatever the caption and sub-line do not use.
 *
 * The comparison page gave every widget all three lines, which is not what the
 * real objects look like: captions ship on six types and only on NEW objects, so
 * across the layouts that exist today most readouts are a value alone. Sizing
 * those at the three-line share left a small value floating in an empty box —
 * strictly worse than the fit-to-fill it replaced, and invisible in a mockup
 * where every widget had a caption.
 *
 * So the budget is fixed and the value takes the remainder. A caption-less clock
 * fills its box; adding a caption makes room by shrinking the value, which is
 * the trade the operator is actually choosing when they type one.
 *
 * @param boxH the widget's outer height in layout pixels
 * @param captionPx the caption's rendered size, or 0 when there is no caption
 * @param subPx the sub-line's rendered size, or 0 when there is no sub-line
 */
export function valueSizeFor(boxH: number, captionPx: number, subPx: number): number {
  const spent =
    (captionPx > 0 ? captionPx * CAPTION_LEADING + boxH * GAP_SCALE : 0) +
    (subPx > 0 ? subPx * SUB_LEADING + boxH * GAP_SCALE : 0);
  // Floor so a box short enough that the caption's pixel minimum eats the whole
  // budget still shows a value rather than collapsing it to nothing.
  return Math.max(boxH * CONTENT_SCALE - spent, boxH * VALUE_FLOOR_SCALE) / VALUE_LEADING;
}

/**
 * The whole composition, guaranteed to fit the box it is painted in.
 *
 * `valueSizeFor` shares out a BUDGET, and a budget is a proportion — which stops
 * being enough at the small end, where the caption and sub-line sit on pixel
 * floors that do not shrink with the box. Below about 16px of content height the
 * caption alone is taller than everything available, and the value was rendered
 * anyway and clipped: the exact "OFFLINE cut in half" a status widget shows when
 * it is made small in the editor.
 *
 * So the lines are DROPPED rather than overflowed, least important first. A
 * widget too short for three lines shows two; too short for two shows the value,
 * which is the line it exists for. Nothing is ever painted outside the box.
 *
 * @param boxH the height the composition actually has, in layout pixels — the
 *   content box, not the object's outer height.
 */
/**
 * @param uniform size the VALUE as though the composition had all three lines,
 *   whatever this tile actually carries.
 *
 *   For a GRID of same-height tiles, which is what Home is. There the caption
 *   and sub-line are the surface's, not the operator's, and a tile that happens
 *   to have neither — the clock — took the whole budget and rendered at 52px in a
 *   row of 35px values. On a wall, where a widget is placed alone at a size
 *   somebody chose, filling the box is still right, so this is off by default.
 */
/**
 * The two OPTIONAL pieces below the sub-line, and what they cost.
 *
 * Additive, and off by default, so every existing caller gets exactly the
 * composition it got before — asserted in readout.test.ts rather than assumed.
 * They exist because ProVideoPlayer's "what is on now" widget needs a progress
 * rule and a quiet next-cue line, and the alternative was a SECOND copy of this
 * composition living in a PVP file. One idiom, one implementation, is the whole
 * reason this module exists.
 */
export interface ReadoutExtras {
  /** A hairline progress rule under the sub-line. */
  meter?: boolean;
  /** The quietest line, under everything — a qualified or secondary answer. */
  footer?: boolean;
}

/** The rule's own height, box-relative with a pixel floor so it stays a hairline
 *  on a wall and stays visible in a small tile. */
export const METER_SCALE = 0.014;
export const METER_MIN_PX = 2;

/**
 * How much bigger than its sub-line the value stays once the extras are drawn.
 *
 * The extras take their room FROM THE VALUE — there is nowhere else for it to
 * come from, because `CONTENT_SCALE` was derived for the three-line composition
 * and `avail` leaves 0.15 of the box spare while the footer alone wants 0.17.
 * So a version that refused to touch the value could never draw a footer at any
 * size, and did not: measured across every box height from 1 to 2000 px, the
 * footer rendered at exactly none of them, while the inspector switch and the
 * Home card toggle both wrote a setting for it.
 *
 * The floor is what stops the correction going the other way. Charging the
 * extras to the value with no floor at all put the value BELOW its own sub-line
 * — 0.098 of the box against 0.115 — which is a composition with its emphasis
 * upside down. 1.4 keeps roughly the ratio the approved mockup drew (20px value
 * over a 12.5px sub-line) once both extras are on.
 */
export const VALUE_OVER_SUB = 1.4;

export function fitComposition(
  boxH: number,
  hasCaption: boolean,
  hasSub: boolean,
  uniform = false,
  extras: ReadoutExtras = {},
): { captionPx: number; valuePx: number; subPx: number; meterPx: number; footerPx: number } {
  const avail = Math.max(0, boxH - 2 * boxH * PAD_SCALE);
  const gap = boxH * GAP_SCALE;

  const fullCaptionPx = Math.max(CAPTION_MIN_PX, boxH * CAPTION_SCALE);
  const fullSubPx = Math.max(SUB_MIN_PX, boxH * SUB_SCALE);
  const fullMeterPx = Math.max(METER_MIN_PX, boxH * METER_SCALE);

  const attempt = (caption: boolean, sub: boolean, meter: boolean, footer: boolean) => {
    const captionPx = caption ? fullCaptionPx : 0;
    const subPx = sub ? fullSubPx : 0;
    const meterPx = meter ? fullMeterPx : 0;
    // The footer is a sub-line in every respect but importance, so it is sized
    // as one. A third type size here would be a third thing to tune.
    const footerPx = footer ? fullSubPx : 0;
    // `used` below still counts the lines actually rendered, so the drop-a-line
    // loop is unaffected — and a uniform value is never LARGER than the value
    // the same box would otherwise get, so it cannot start overflowing.
    const spentCaptionPx = uniform ? fullCaptionPx : captionPx;
    const spentSubPx = uniform ? fullSubPx : subPx;
    // The extras take their room from the VALUE, and are charged to `used` once.
    //
    // Both halves of that matter, and each was wrong on its own first. Charging
    // them to `used` only meant the budget could never accommodate them and the
    // footer drew at literally no box height between 1 and 2000 px. Subtracting
    // them from the value AND adding them to `used` cancelled exactly, so `used`
    // came out invariant to them, the drop-a-line loop never fired, and the
    // value silently absorbed the whole cost — falling below its own sub-line,
    // and to font-size 0 around a 60px box.
    //
    // So: subtract once, floored, and count the real cost in `used`.
    const extrasPx =
      (meterPx > 0 ? meterPx + gap : 0) + (footerPx > 0 ? footerPx * SUB_LEADING + gap : 0);
    const rawValuePx = valueSizeFor(boxH, spentCaptionPx, spentSubPx);
    const valuePx =
      extrasPx > 0
        ? Math.max(fullSubPx * VALUE_OVER_SUB, rawValuePx - extrasPx / VALUE_LEADING)
        : rawValuePx;
    const used =
      valuePx * VALUE_LEADING +
      (captionPx > 0 ? captionPx * CAPTION_LEADING + gap : 0) +
      (subPx > 0 ? subPx * SUB_LEADING + gap : 0) +
      extrasPx;
    return { captionPx, valuePx, subPx, meterPx, footerPx, used };
  };

  const wantMeter = extras.meter ?? false;
  const wantFooter = extras.footer ?? false;

  // An unmeasured box is UNKNOWN, not tiny. Before the first measurement — and
  // anywhere without layout at all — the composition is drawn whole and the
  // measurement corrects it, rather than every widget flashing up as a bare
  // value and growing its caption a frame later.
  if (boxH <= 0) return attempt(hasCaption, hasSub, wantMeter, wantFooter);

  // In order of what may be given up. The footer is a QUALIFIED answer and goes
  // first; the rule restates a number that is already written out; the sub-line
  // qualifies the value; the caption names it; and the value IS it.
  const order = [
    [hasCaption, hasSub, wantMeter, wantFooter],
    [hasCaption, hasSub, wantMeter, false],
    [hasCaption, hasSub, false, false],
    [hasCaption, false, false, false],
    [false, false, false, false],
  ] as const;
  for (const [caption, sub, meter, footer] of order) {
    const tried = attempt(caption, sub, meter, footer);
    if (tried.used <= avail) return tried;
  }
  // Even the value alone is taller than the box. Give it exactly what there is,
  // so a widget shrunk to a sliver draws a sliver rather than spilling over the
  // object next to it.
  return { captionPx: 0, valuePx: Math.max(1, avail / VALUE_LEADING), subPx: 0, meterPx: 0, footerPx: 0 };
}
