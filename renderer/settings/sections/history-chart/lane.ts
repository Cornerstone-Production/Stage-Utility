// lane.ts — the item lane under the x axis: where each plan item's block sits,
// and what it is allowed to say.
//
// Pure, and takes the text measurer as an argument, because the label rule is
// the one part of the chart that has a wrong answer ("Welcome & Announ…") and
// jsdom measures every string as the same width. The component passes a real
// canvas measurer; the tests pass an arithmetic one.

/** One plan item as the chart needs it. Narrower than ServiceTimelineItem so the
 *  SPL side, which has its own item shape, can feed the same lane. */
export interface LaneItem {
  itemId: string;
  title: string;
  /** Order within the service. The lane's fallback label is `sequence + 1`, the
   *  same number the rundown table prints in its first column. */
  sequence: number;
  startedAt: string;
  /** null while the item is still live — its segment grows to the live edge. */
  endedAt: string | null;
  /** Above the SERVICE START header when recorded. Draws in the upper row, outlined. */
  preService: boolean;
  plannedSec: number | null;
  actualSec: number | null;
  /** Sound only: this item's loudest reading, as it should read in the strip. */
  peakLabel?: string | null;
}

/** A placed item block. `x0`/`x1` are plot coordinates, already clipped to the plot. */
export interface LaneSegment {
  item: LaneItem;
  row: "pre" | "service";
  x0: number;
  x1: number;
  /** false when the item's window falls entirely outside the drawn x domain. */
  visible: boolean;
}

/** What a segment is allowed to print. Never a truncated title — a clipped
 *  string reads as a different item, so the rule degrades to the number instead. */
export type LaneLabel =
  | { kind: "title"; text: string }
  | { kind: "number"; text: string }
  | { kind: "none"; text: "" };

/** Measures a string in the lane's font, in px. */
export type MeasureText = (text: string) => number;

/** Padding a label needs inside its block before it reads as inside it. */
export const LANE_LABEL_PADDING = 12;

/**
 * The label rule: the full title when it fits with 12px to spare, otherwise the
 * rundown number when THAT fits, otherwise nothing.
 *
 * Nothing is ever clipped and nothing is ever ellipsised. A two-character
 * number in a 14px block is still a lie about which item it is, so the number
 * is measured too rather than assumed to fit.
 */
export function laneLabel(item: LaneItem, widthPx: number, measure: MeasureText): LaneLabel {
  const title = item.title?.trim() ?? "";
  if (title && measure(title) + LANE_LABEL_PADDING <= widthPx) return { kind: "title", text: title };
  const number = String(item.sequence + 1);
  if (measure(number) + LANE_LABEL_PADDING <= widthPx) return { kind: "number", text: number };
  return { kind: "none", text: "" };
}

/**
 * Place every item on the plot's x scale.
 *
 * A live item (`endedAt` null) runs to `liveEdgeMs`, which is the domain's right
 * edge while recording — that is what makes the current item's block grow rather
 * than vanish. Items are placed even when they extend past the domain; they are
 * clipped to the plot, and `visible` is false only when nothing of them is inside.
 */
export function laneSegments(
  items: LaneItem[],
  opts: {
    domainStartMs: number;
    domainEndMs: number;
    liveEdgeMs: number;
    plotX0: number;
    plotX1: number;
  },
): LaneSegment[] {
  const { domainStartMs, domainEndMs, liveEdgeMs, plotX0, plotX1 } = opts;
  const span = domainEndMs - domainStartMs || 1;
  const toX = (ms: number) => plotX0 + ((ms - domainStartMs) / span) * (plotX1 - plotX0);
  const clip = (x: number) => Math.min(plotX1, Math.max(plotX0, x));
  const out: LaneSegment[] = [];
  for (const item of items) {
    const s = Date.parse(item.startedAt);
    if (!Number.isFinite(s)) continue;
    const rawEnd = item.endedAt ? Date.parse(item.endedAt) : liveEdgeMs;
    const e = Number.isFinite(rawEnd) ? Math.max(s, rawEnd) : liveEdgeMs;
    const visible = e >= domainStartMs && s <= domainEndMs;
    out.push({
      item,
      row: item.preService ? "pre" : "service",
      x0: clip(toX(s)),
      x1: clip(toX(e)),
      visible,
    });
  }
  return out;
}

/** The segment under a plot x, or null. Later items win where blocks abut, so a
 *  boundary hover names the item that is starting rather than the one that ended. */
export function segmentAt(segments: LaneSegment[], x: number, row: "pre" | "service"): LaneSegment | null {
  let hit: LaneSegment | null = null;
  for (const s of segments) {
    if (s.visible && s.row === row && x >= s.x0 && x <= s.x1) hit = s;
  }
  return hit;
}
