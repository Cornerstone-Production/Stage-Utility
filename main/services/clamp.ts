// clamp.ts — hold a number inside a range.
//
// Written out longhand as a nested `Math.max(lo, Math.min(hi, v))` in thirty-two
// places — the wireless drivers, the poll schedulers, the layout editor, and
// every meter that draws bars. Two spellings were in use — the nested min-inside-max
// and its mirror, `Math.min(Math.max(v, lo), hi)` — which are the same thing
// only while `lo <= hi`, and read as noise either way at the call site.
//
// Two copies already existed — shure-base.ts for the wireless drivers, and the
// renderer's layout-geometry.ts — and neither was reachable from the other half
// of the app. Both now re-export this one, so nothing importing them changed.
//
// It was NOT swept in mechanically. See clamp.test.ts for why that fails.

/**
 * `v`, held between `lo` and `hi`.
 *
 * With `lo > hi` the low bound wins, which is what the nested form this replaces
 * did — worth naming rather than leaving to be re-derived from the nesting order
 * at each call site.
 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
