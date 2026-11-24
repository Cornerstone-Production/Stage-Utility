// fader-scale.ts — where a level sits on a Q-SYS fader's travel.
//
// Linear in dB from a floor to the top, as the approved panel mockup draws it
// (-60 to +12): the floor is -60 dB, or the allowlist's minimum when that is
// higher, or 12 dB under the top when the top is at or below -60; the top is the
// allowlist's maximum, or the Core's when there is none.
// The very bottom of travel is the lowest value the fader may write (the Core's
// minimum, typically -100 dB, read as "-inf"); everything below the floor sits
// there. A gain fader spends its travel where people listen, not on -100..-60.
//
// One scale for the thumb, the drag, the limit line, the tick marks and the
// slider's aria values, so the thumb never jumps when the Core's answer lands.

export const FADER_FLOOR_DB = -60;
/** With a low top, how far under it the linear part starts. */
const FLOOR_BELOW_TOP_DB = 12;

/** The staff strip's marks, as many as fall inside the scale. */
export const TICK_MARKS_DB = [12, 0, -12, -24, -36, -48, -60];

export interface FaderScale {
  /** The lowest value the fader writes: the bottom of travel. */
  bottom: number;
  /** Where the linear part of travel starts. */
  floor: number;
  /** The top of travel: the highest value the fader writes. */
  top: number;
}

/** The scale for a control's Core range and its allowlist limits; null without a usable range. */
export function faderScale(range: { min: number; max: number } | null, limits: { min: number | null; max: number | null }): FaderScale | null {
  if (!range) return null;
  const bottom = Math.max(range.min, limits.min ?? range.min);
  const top = Math.min(range.max, limits.max ?? range.max);
  if (!(top > bottom)) return null;
  // A top at or under -60 dB would leave no linear part at all; the floor then sits
  // 12 dB under it (one tick), so the travel stays a fader rather than two stops.
  const floor = Math.max(bottom, Math.min(FADER_FLOOR_DB, top - FLOOR_BELOW_TOP_DB));
  return { bottom, floor, top };
}

/** 0..1 along the travel for value `v`. */
export function travelOf(s: FaderScale, v: number): number {
  if (v >= s.top) return 1;
  if (v <= s.floor) return 0;
  return (v - s.floor) / (s.top - s.floor);
}

/** The value at `n` (0..1) along the travel; the bottom stop is the bottom value. */
export function valueAt(s: FaderScale, n: number): number {
  if (n <= 0) return s.bottom;
  if (n >= 1) return s.top;
  return s.floor + n * (s.top - s.floor);
}

/** At the bottom stop, below the linear part: drawn "-inf", as the mockup does. */
export function atBottom(s: FaderScale, v: number): boolean {
  return s.bottom < s.floor && v <= s.bottom + 1e-6;
}

/** One step up or down from `v`, `step` dB, kept on the scale: from below the floor, up goes to the floor; from the floor, down goes to the bottom. */
export function stepFrom(s: FaderScale, v: number, dir: 1 | -1, step: number): number {
  if (dir === 1) return Math.min(s.top, v < s.floor ? s.floor : v + step);
  const next = v - step;
  return next < s.floor ? (v > s.floor ? s.floor : s.bottom) : next;
}

/**
 * A standalone meter's window: -60..+12 dB, as the approved mockup draws it.
 * Not the control's own range: a meter control reports -100..+20, and spending
 * that linearly gives the bottom 40 dB of the bar to levels nobody listens to.
 */
export const STANDALONE_METER_SCALE: FaderScale = { bottom: FADER_FLOOR_DB, floor: FADER_FLOOR_DB, top: 12 };

/**
 * 0..1 bar height for a meter reading on `scale`: its fader's, so a strip's meter
 * and fader line up, or the standalone window. Below the floor is empty ("-inf").
 * A reading that is not a number (a meter the Core reports as text) falls back to
 * the Core's own position.
 */
export function meterLevel(r: { value: unknown; position: number | null }, scale: FaderScale | null): number {
  if (typeof r.value === "number" && Number.isFinite(r.value)) return travelOf(scale ?? STANDALONE_METER_SCALE, r.value);
  return r.position === null ? 0 : Math.min(1, Math.max(0, r.position));
}
