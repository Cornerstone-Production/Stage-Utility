// qsys-taper.ts — where a Q-SYS fader sits for a value: the Core's own taper.
//
// A Core reports a fader's place as Position (0..1), on a taper of its own that is
// not linear in dB. The tables below are that taper as measured on a Core, Value
// to Position, keyed by the control's range (ValueMin..ValueMax). Between measured
// points the taper is interpolated linearly, which is monotone both ways, so a
// value maps to one place on the travel and a place back to one value.
//
// A panel draws a fader on a measured range by this table, so a thumb sits where
// the same fader sits on a Q-SYS UCI. A range with no table falls back to the
// panel's dB-linear scale (renderer/main/qsys/fader-scale.ts); the server logs it
// once and /qsys/manage lists it, so it can be measured and added here.

import { walkLayoutObjects, type LayoutObjectConfig, type View } from "./views.js";
import type { QsysAddress } from "./qsys.js";

/** One measured taper: the control range it applies to, and its points, Value to Position, value ascending. */
export interface Taper {
  min: number;
  max: number;
  points: readonly (readonly [value: number, position: number])[];
}

/**
 * Every measured taper, one per range, sorted by min then max. Measured on Q-SYS
 * Designer 10.0.1 in Emulate, a mixer's output gain (-100..+10 dB), by setting
 * Value and reading Position.
 */
export const MEASURED_TAPERS: readonly Taper[] = [
  {
    min: -100,
    max: 10,
    points: [
      [-100, 0],
      [-60, 0.08],
      [-40, 0.166],
      [-30, 0.247],
      [-20, 0.35],
      [-10, 0.5],
      [-6, 0.585],
      [-3, 0.663],
      [0, 0.75],
      [3, 0.837],
      [6, 0.915],
      [10, 1],
    ],
  },
];

/** A catalog control's own range: finite, min under max; null when it reports none. The one rule for "has a range". */
export function rangeOf(c: { ValueMin?: unknown; ValueMax?: unknown }): { min: number; max: number } | null {
  const { ValueMin: min, ValueMax: max } = c;
  return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}

/** How a range is written in a log line and on /qsys/manage: `-100..10`. */
export const rangeText = (r: { min: number; max: number }): string => `${r.min}..${r.max}`;

/** The measured taper for exactly this range, or null when there is none. */
export function taperFor(range: { min: number; max: number } | null): Taper | null {
  if (!range) return null;
  return MEASURED_TAPERS.find((t) => t.min === range.min && t.max === range.max) ?? null;
}

/** Interpolate between the two points around `x`, reading `from` and writing `to` (0 value, 1 position). */
function along(t: Taper, x: number, from: 0 | 1, to: 0 | 1): number {
  const pts = t.points;
  if (x <= pts[0]![from]) return pts[0]![to];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x <= b[from]) return a[to] + ((x - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
  }
  return pts[pts.length - 1]![to];
}

/** 0..1 along the Core's travel for value `v` (clamped to the range). */
export const positionOf = (t: Taper, v: number): number => along(t, v, 0, 1);

/** The value at `p` (0..1) along the Core's travel (clamped to the range). */
export const valueOf = (t: Taper, p: number): number => along(t, p, 1, 0);

/** The control a fader-like object writes as a level: a fader's, a strip's gain. */
function levelBinding(config: LayoutObjectConfig): QsysAddress | null {
  if (config.type === "qsys-fader") return config.binding ?? null;
  if (config.type === "qsys-strip") return config.gain ?? null;
  return null;
}

/** A control range with no measured taper, and the fader controls bound on it. */
export interface UntaperedRange {
  min: number;
  max: number;
  /** Sorted by component, then control; each once. */
  controls: QsysAddress[];
}

/**
 * The ranges of every control a fader or a strip's level is bound to, in any view,
 * that have no measured taper: such a fader moves linearly in dB, not as the Core's
 * own fader does. Sorted by min then max. A binding the Core does not have, or a
 * control with no range, is the binding check's to report, not this.
 */
export function untaperedRanges(views: readonly View[], catalog: { components: { name: string; controls: { Name: string; ValueMin?: unknown; ValueMax?: unknown }[] }[] }): UntaperedRange[] {
  const controls = new Map(catalog.components.map((c) => [c.name, new Map(c.controls.map((x) => [x.Name, x]))]));
  const byRange = new Map<string, UntaperedRange & { seen: Set<string> }>();
  for (const view of views) {
    walkLayoutObjects(view.layout?.objects ?? [], (o) => {
      const a = levelBinding(o.config);
      const c = a ? controls.get(a.component)?.get(a.control) : undefined;
      const range = c ? rangeOf(c) : null;
      if (!a || !range || taperFor(range)) return;
      const k = rangeText(range);
      const entry = byRange.get(k) ?? { ...range, controls: [], seen: new Set<string>() };
      byRange.set(k, entry);
      const id = `${a.component}\u0000${a.control}`;
      if (entry.seen.has(id)) return;
      entry.seen.add(id);
      entry.controls.push({ component: a.component, control: a.control });
    });
  }
  return [...byRange.values()]
    .map(({ seen: _seen, ...r }) => ({ ...r, controls: r.controls.sort((x, y) => x.component.localeCompare(y.component) || x.control.localeCompare(y.control)) }))
    .sort((x, y) => x.min - y.min || x.max - y.max);
}
