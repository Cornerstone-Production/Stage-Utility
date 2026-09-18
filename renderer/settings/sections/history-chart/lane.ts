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
  /** Sound only: this item's loudest reading, already formatted.
   *
   *  Does two things, and both are the point: it puts a tick on the block, and
   *  it is what the stat strip says when that block is hovered. A tick with no
   *  number anywhere is a mark nobody can read. */
  peakLabel?: string | null;
}

/** A placed item block. `x0`/`x1` are plot coordinates, already clipped to the plot. */
export interface LaneSegment {
  item: LaneItem;
  row: "pre" | "service";
  /**
   * How far BELOW its row this block is stacked, 0 for the row itself.
   *
   * Items can overlap — a recorder that reopened an item, a service whose
   * occurrence split was missed, a hand-edited window — and two blocks on the
   * same line then draw one on top of the other. The one underneath is
   * invisible, unlabelled and unreachable: the hover took whichever came last.
   * An overlapping block moves down a lane instead.
   */
  lane: number;
  x0: number;
  x1: number;
  /** false when the item's window falls entirely outside the drawn x domain. */
  visible: boolean;
}

/** How many extra lanes a row may grow. Past this an item shares the deepest
 *  one: three stacked rows is already more lane than plot, and a service with
 *  four simultaneous items has a recording problem, not a layout problem. */
export const MAX_EXTRA_LANES = 2;

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
  /** The right edge in use in each lane of each row, so an overlapping block can
   *  find the first lane it fits in. */
  const busy = new Map<string, number[]>();
  for (const item of items) {
    const s = Date.parse(item.startedAt);
    if (!Number.isFinite(s)) continue;
    const rawEnd = item.endedAt ? Date.parse(item.endedAt) : liveEdgeMs;
    const e = Number.isFinite(rawEnd) ? Math.max(s, rawEnd) : liveEdgeMs;
    const visible = e >= domainStartMs && s <= domainEndMs;
    const row: "pre" | "service" = item.preService ? "pre" : "service";
    let ends = busy.get(row);
    if (!ends) busy.set(row, (ends = []));
    // The first lane whose last block has already finished. Compared on the
    // MILLISECOND, not the pixel: two items a second apart round to the same x
    // on an hour-wide plot, and stacking on that would put a lane under half
    // the blocks of a perfectly normal service.
    let lane = ends.findIndex((end) => end <= s);
    if (lane === -1) lane = Math.min(ends.length, MAX_EXTRA_LANES);
    ends[lane] = e;
    out.push({
      item,
      row,
      lane,
      x0: clip(toX(s)),
      x1: clip(toX(e)),
      visible,
    });
  }
  return out;
}

/**
 * The segment under a plot x, or null.
 *
 * The TOPMOST one — the smallest `lane` — because that is the block the pointer
 * is over. Within one lane the later item wins, so a hover on a shared boundary
 * names the item that is starting rather than the one that ended.
 */
export function segmentAt(segments: LaneSegment[], x: number, row: "pre" | "service"): LaneSegment | null {
  let hit: LaneSegment | null = null;
  for (const s of segments) {
    if (!s.visible || s.row !== row || x < s.x0 || x > s.x1) continue;
    if (!hit || s.lane <= hit.lane) hit = s;
  }
  return hit;
}
