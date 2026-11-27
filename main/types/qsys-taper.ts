// qsys-taper.ts — where a Q-SYS fader sits for a value: the Core's own taper.
//
// A Core reports a fader's place as Position (0..1), on a taper of its own that is
// not linear in dB, and not the same for every kind of component: a mixer's gain
// is a dense curve, a Gain block's is a straight line. The tables below are that
// taper as measured on a Core, Value to Position, keyed by the component's Type
// and the control's range (ValueMin..ValueMax), never by the range alone: a Gain
// block configured -100..10 is linear, and must not get the mixer's curve. Between measured
// points the taper is interpolated linearly, which is monotone both ways, so a
// value maps to one place on the travel and a place back to one value.
//
// A panel draws a fader on a measured range by this table, so a thumb sits where
// the same fader sits on a Q-SYS UCI. A range with no table falls back to the
// panel's dB-linear scale (renderer/main/qsys/fader-scale.ts); the server logs it
// once and /qsys/manage lists it, by type and range, so it can be measured and added here.

import { walkLayoutObjects, type LayoutObjectConfig, type View } from "./views.js";
import type { QsysAddress } from "./qsys.js";

/** One measured taper: the component Type and control range it applies to, and its points, Value to Position, value ascending. */
export interface Taper {
  /** The component's Type as Component.GetComponents reports it (`mixer`, `gain`). */
  type: string;
  min: number;
  max: number;
  points: readonly (readonly [value: number, position: number])[];
}

/**
 * Every measured taper, one per component Type and range, sorted by type, then min,
 * then max. Measured on Q-SYS Designer 10.0.1 in Emulate by setting a control by
 * Position and reading Value: a mixer's output gain (-100..+10 dB) at every 0.025
 * of travel, and a Gain block's gain (-100..+20 dB), exactly linear.
 */
export const MEASURED_TAPERS: readonly Taper[] = [
  {
    type: "gain",
    min: -100,
    max: 20,
    points: [
      [-100, 0],
      [20, 1],
    ],
  },
  {
    type: "mixer",
    min: -100,
    max: 10,
    points: [
        [-100, 0],
        [-87.5, 0.025],
        [-75, 0.05],
        [-62.5, 0.075],
        [-50, 0.1],
        [-46.034, 0.125],
        [-42.308, 0.15],
        [-38.813, 0.175],
        [-35.538, 0.2],
        [-32.476, 0.225],
        [-29.615, 0.25],
        [-26.947, 0.275],
        [-24.462, 0.3],
        [-22.149, 0.325],
        [-20, 0.35],
        [-18.005, 0.375],
        [-16.154, 0.4],
        [-14.437, 0.425],
        [-12.846, 0.45],
        [-11.37, 0.475],
        [-10, 0.5],
        [-8.726, 0.525],
        [-7.538, 0.55],
        [-6.428, 0.575],
        [-5.385, 0.6],
        [-4.399, 0.625],
        [-3.462, 0.65],
        [-2.562, 0.675],
        [-1.692, 0.7],
        [-0.841, 0.725],
        [0, 0.75],
        [0.841, 0.775],
        [1.692, 0.8],
        [2.562, 0.825],
        [3.462, 0.85],
        [4.399, 0.875],
        [5.385, 0.9],
        [6.428, 0.925],
        [7.538, 0.95],
        [8.726, 0.975],
        [10, 1],
    ],
  },
];

/** A catalog control's own range: finite, min under max; null when it reports none. The one rule for "has a range". */
export function rangeOf(c: { ValueMin?: unknown; ValueMax?: unknown }): { min: number; max: number } | null {
  const { ValueMin: min, ValueMax: max } = c;
  return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}

/** A control kind as it is written in a log line and on /qsys/manage: `gain -100..10`. */
export const kindText = (k: { type: string; min: number; max: number }): string => `${k.type} ${k.min}..${k.max}`;

/** The measured taper for exactly this component Type and range, or null when there is none (or no type is known). */
export function taperFor(type: string | null, range: { min: number; max: number } | null): Taper | null {
  if (!type || !range) return null;
  return MEASURED_TAPERS.find((t) => t.type === type && t.min === range.min && t.max === range.max) ?? null;
}

/** A taper point's columns: its value, and its Position. */
const VALUE = 0;
const POSITION = 1;
type Column = typeof VALUE | typeof POSITION;

/**
 * Read `x` in column `from` across the taper and answer column `to`, interpolating
 * between the two points around it and holding at the ends. Fails closed: `x` that
 * is not a number reads as the bottom, never the top.
 */
function interpolateTaper(t: Taper, x: number, from: Column, to: Column): number {
  const pts = t.points;
  if (!(x > pts[0]![from])) return pts[0]![to];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x <= b[from]) return a[to] + ((x - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
  }
  return pts[pts.length - 1]![to];
}

/** 0..1 along the Core's travel for value `v` (clamped to the range; NaN is the bottom). */
export const positionOf = (t: Taper, v: number): number => interpolateTaper(t, v, VALUE, POSITION);

/** The value at `p` (0..1) along the Core's travel (clamped to the range; NaN is the bottom). */
export const valueOf = (t: Taper, p: number): number => interpolateTaper(t, p, POSITION, VALUE);

/** The control a fader-like object writes as a level: a fader's, a strip's gain. */
function levelBinding(config: LayoutObjectConfig): QsysAddress | null {
  if (config.type === "qsys-fader") return config.binding ?? null;
  if (config.type === "qsys-strip") return config.gain ?? null;
  return null;
}

/** As much of the Core's catalog (`GET /api/qsys/catalog`) as the taper check reads: each component's controls and their ranges. */
export interface TaperCatalog {
  components: { name: string; type: string; controls: { Name: string; ValueMin?: unknown; ValueMax?: unknown }[] }[];
}

/** A component Type and control range with no measured taper, and the fader controls bound on it. */
export interface UntaperedRange {
  type: string;
  min: number;
  max: number;
  /** Sorted by component, then control; each once. */
  controls: QsysAddress[];
}

/**
 * The component Type and range of every control a fader or a strip's level is bound to, in any view,
 * that have no measured taper: such a fader moves linearly in dB, not as the Core's
 * own fader does. Sorted by type, then min, then max. A binding the Core does not have, or a
 * control with no range, is the binding check's to report, not this.
 */
export function untaperedRanges(views: readonly View[], catalog: TaperCatalog): UntaperedRange[] {
  const components = new Map(catalog.components.map((c) => [c.name, { type: c.type, controls: new Map(c.controls.map((x) => [x.Name, x])) }]));
  const byRange = new Map<string, UntaperedRange & { seen: Set<string> }>();
  for (const view of views) {
    walkLayoutObjects(view.layout?.objects ?? [], (o) => {
      const a = levelBinding(o.config);
      const comp = a ? components.get(a.component) : undefined;
      const c = a ? comp?.controls.get(a.control) : undefined;
      const range = c ? rangeOf(c) : null;
      if (!a || !comp || !range || taperFor(comp.type, range)) return;
      const k = kindText({ type: comp.type, ...range });
      const entry = byRange.get(k) ?? { type: comp.type, ...range, controls: [], seen: new Set<string>() };
      byRange.set(k, entry);
      const id = `${a.component}\u0000${a.control}`;
      if (entry.seen.has(id)) return;
      entry.seen.add(id);
      entry.controls.push({ component: a.component, control: a.control });
    });
  }
  return [...byRange.values()]
    .map(({ seen: _seen, ...r }) => ({ ...r, controls: r.controls.sort((x, y) => x.component.localeCompare(y.component) || x.control.localeCompare(y.control)) }))
    .sort((x, y) => x.type.localeCompare(y.type) || x.min - y.min || x.max - y.max);
}
