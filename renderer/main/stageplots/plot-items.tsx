// plot-items.tsx — a plot's items, drawn inside PlotSvg. One drawing for the
// editor, /stageplots, print and the published page.
//
// Draw order: zones, then boxes and circles, then cables, then symbols and
// connection points, then text; within a layer, the order they were added. The
// selected item is drawn last, on top of everything.
//
// Shapes and symbols scale with the plot. Labels do not: their font size is a
// fixed number of screen pixels (`fs` is that size in plot units, recomputed as
// the plot is zoomed or resized), and they sit outside an item's rotation so
// they always read level.
//
// Each item is its own memoised component and the editor replaces only the
// item that changed, so dragging one item of five hundred redraws one. Pointer
// handling is by delegation on the SVG: an item carries data-id, a selection
// handle data-hd ("size", "rot", "pt") and, for a cable point, data-pi.

import { memo, type ReactNode } from "react";

import type { PlotItem } from "@main/types/stageplots";

import { calloutNumbers } from "./legend";
import { MonoTspans } from "./mono";
import { Part, SYMBOLS } from "./symbols";

const INK = "var(--su-plot-ink)";
const LABEL = "var(--su-plot-label)";
const PAPER = "var(--su-plot-paper)";
const ACCENT = "var(--su-accent)";

/** One decimal: enough at any zoom, and short in the DOM. */
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Draw order layer: zones under shapes under cables under symbols under text. */
function layer(it: PlotItem): number {
  if (it.type === "zone") return 0;
  if (it.type === "box" || it.type === "circle") return 1;
  if (it.type === "cable") return 2;
  if (it.type === "text") return 4;
  return 3;
}

/** `items` in the order they are drawn: by layer, then as added, the selected one last. */
export function drawOrder(items: readonly PlotItem[], selectedId: string | null | undefined): PlotItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => Number(a.it.id === selectedId) - Number(b.it.id === selectedId) || layer(a.it) - layer(b.it) || a.i - b.i)
    .map((x) => x.it);
}

/**
 * Test hook: called with an item's id each time that item renders. Lets a test
 * count re-renders while one item of many is dragged. Null in the app.
 */
export const itemRenderProbe: { current: ((id: string) => void) | null } = { current: null };

interface ItemProps {
  item: PlotItem;
  /** Plot units per screen pixel. */
  k: number;
  /** Label font size, in plot units. */
  fs: number;
  selected: boolean;
  tapped: boolean;
  calloutNo: number | undefined;
  labels: boolean;
}

function Label({ x, y, fs, anchor, children }: { x: number; y: number; fs: number; anchor?: "middle"; children: string }) {
  return (
    <text
      x={r1(x)}
      y={r1(y)}
      textAnchor={anchor}
      fontSize={r1(fs)}
      fontWeight={500}
      className="font-sans"
      style={{ fill: LABEL, stroke: PAPER, strokeWidth: r1(fs * 0.34), strokeLinejoin: "round", paintOrder: "stroke" }}
    >
      <MonoTspans text={children} />
    </text>
  );
}

function CableItem({ item: it, k, fs, selected, tapped, labels }: ItemProps) {
  const pts = it.points ?? [];
  const col = it.color ?? INK;
  const line = pts.map((p) => p.join(",")).join(" ");
  // The label sits on the middle of the longest run.
  let at = 0;
  let longest = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (len > longest) [longest, at] = [len, i];
  }
  const [a, b] = [pts[at], pts[at + 1] ?? pts[at]];
  const [first, last] = [pts[0], pts[pts.length - 1]];
  return (
    <>
      <polyline points={line} fill="none" stroke="transparent" strokeWidth={r1(16 * k)} />
      {tapped && <polyline points={line} fill="none" strokeWidth={r1(7 * k)} style={{ stroke: ACCENT, strokeOpacity: 0.35 }} strokeLinecap="round" />}
      <polyline
        points={line}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={r1(2.6 * k)}
        strokeDasharray={it.dashed ? `${r1(9 * k)} ${r1(6 * k)}` : undefined}
        style={{ stroke: col }}
      />
      {first && <circle cx={first[0]} cy={first[1]} r={r1(3.5 * k)} style={{ fill: col }} />}
      {last && <circle cx={last[0]} cy={last[1]} r={r1(3.5 * k)} style={{ fill: col }} />}
      {it.label && labels && a && (
        <Label x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 + fs * 0.35} fs={fs} anchor="middle">
          {it.label}
        </Label>
      )}
      {selected &&
        pts.map((p, i) => (
          <circle
            key={i}
            data-hd="pt"
            data-pi={i}
            data-testid={`h-pt-${i}`}
            cx={p[0]}
            cy={p[1]}
            r={r1(6 * k)}
            strokeWidth={r1(1.5 * k)}
            className="cursor-crosshair"
            style={{ fill: PAPER, stroke: ACCENT }}
          />
        ))}
    </>
  );
}

function body(it: PlotItem, k: number, fs: number, calloutNo: number | undefined, labels: boolean): ReactNode {
  const { w, h } = it;
  const [hw, hh] = [w / 2, h / 2];
  const col = it.color ?? INK;
  const sw = r1(1.75 * k);
  switch (it.type) {
    case "box":
      return <rect x={-hw} y={-hh} width={w} height={h} rx={r1(4 * k)} strokeWidth={sw} style={{ fill: col, fillOpacity: 0.08, stroke: col }} />;
    case "circle":
      return <ellipse rx={hw} ry={hh} strokeWidth={sw} style={{ fill: col, fillOpacity: 0.08, stroke: col }} />;
    case "zone":
      return (
        <rect
          x={-hw}
          y={-hh}
          width={w}
          height={h}
          rx={r1(10 * k)}
          strokeWidth={sw}
          strokeDasharray={`${r1(7 * k)} ${r1(5 * k)}`}
          style={{ fill: col, fillOpacity: 0.13, stroke: col }}
        />
      );
    case "conn": {
      const m = Math.min(w, h);
      return (
        <>
          <rect x={-hw} y={-hh} width={w} height={h} rx={r1(m * 0.24)} style={{ fill: col }} />
          <circle r={r1(m * 0.26)} style={{ fill: PAPER }} />
          <circle r={r1(m * 0.1)} style={{ fill: col }} />
        </>
      );
    }
    case "symbol": {
      const def = it.symbol ? SYMBOLS[it.symbol] : null;
      return (
        <g
          data-symbol={it.symbol}
          transform={`translate(${-hw} ${-hh}) scale(${w / 100} ${h / 100})`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ color: col }}
          className="[&>*]:[vector-effect:non-scaling-stroke]"
        >
          {def?.parts.map((p, i) => <Part key={i} part={p} />)}
        </g>
      );
    }
    case "text": {
      if (it.textKind === "callout") {
        const m = Math.min(w, h) / 2;
        return (
          <>
            <circle r={m} style={{ fill: col }} />
            <text textAnchor="middle" y={r1(m * 0.38)} fontSize={r1(m * 1.05)} fontWeight={600} className="font-mono" style={{ fill: PAPER }}>
              {calloutNo ?? ""}
            </text>
          </>
        );
      }
      if (it.textKind === "dimension") {
        const a = fs * 0.55;
        return (
          <>
            <g strokeWidth={sw} fill="none" style={{ stroke: col }}>
              <path d={`M${-hw} 0H${hw}M${-hw} ${-a}V${a}M${hw} ${-a}V${a}`} />
              <path d={`M${-hw + a * 1.4} ${-a * 0.6}L${-hw} 0L${-hw + a * 1.4} ${a * 0.6}M${hw - a * 1.4} ${-a * 0.6}L${hw} 0L${hw - a * 1.4} ${a * 0.6}`} />
            </g>
            {labels && it.label && (
              <Label x={0} y={-fs * 0.55} fs={fs} anchor="middle">
                {it.label}
              </Label>
            )}
          </>
        );
      }
      // A text label scales with the plot: its size is the box's height.
      return (
        <text
          textAnchor="middle"
          y={r1(h * 0.2)}
          fontSize={r1(h * 0.6)}
          fontWeight={500}
          className="font-sans"
          style={{ fill: it.color ?? LABEL, stroke: PAPER, strokeWidth: r1(h * 0.14), strokeLinejoin: "round", paintOrder: "stroke" }}
        >
          <MonoTspans text={it.label} />
        </text>
      );
    }
    default:
      return null;
  }
}

/** The gap between an item and its selection handles, in screen pixels. */
export const HANDLE_PAD = 6;
/** The rotate handle's stalk, in screen pixels. */
const ROTATE_STALK = 26;

/**
 * Whether the rotate handle goes under the item: when, above it, the handle
 * would sit outside the plot's top edge where nobody can reach it.
 */
export function rotateHandleBelow(it: Pick<PlotItem, "y" | "h" | "rotation">, k: number): boolean {
  const reach = it.h / 2 + (HANDLE_PAD + ROTATE_STALK + 6) * k;
  return it.y + it.h / 2 - reach * Math.cos((it.rotation * Math.PI) / 180) < 0;
}

function Selection({ hw, hh, k, below }: { hw: number; hh: number; k: number; below: boolean }) {
  const pad = HANDLE_PAD * k;
  const hs = 10 * k;
  const rl = ROTATE_STALK * k;
  const lw = r1(1.5 * k);
  // Under the item the stalk and handle mirror: the canvas turns a drag of it the other way.
  const dir = below ? 1 : -1;
  return (
    <>
      <rect
        x={r1(-hw - pad)}
        y={r1(-hh - pad)}
        width={r1(2 * (hw + pad))}
        height={r1(2 * (hh + pad))}
        fill="none"
        strokeWidth={lw}
        strokeDasharray={`${r1(4 * k)} ${r1(3 * k)}`}
        style={{ stroke: ACCENT }}
      />
      <line x1={0} y1={r1(dir * (hh + pad))} x2={0} y2={r1(dir * (hh + pad + rl))} strokeWidth={lw} style={{ stroke: ACCENT }} />
      <circle
        data-hd="rot"
        data-testid="h-rot"
        data-below={below ? "" : undefined}
        cy={r1(dir * (hh + pad + rl))}
        r={r1(hs * 0.6)}
        strokeWidth={lw}
        className="cursor-grab"
        style={{ fill: PAPER, stroke: ACCENT }}
      />
      <rect
        data-hd="size"
        data-testid="h-size"
        x={r1(hw + pad - hs / 2)}
        y={r1(hh + pad - hs / 2)}
        width={r1(hs)}
        height={r1(hs)}
        strokeWidth={lw}
        className="cursor-nwse-resize"
        style={{ fill: PAPER, stroke: ACCENT }}
      />
    </>
  );
}

/** Where an item's label goes, outside its rotation: inside the top-left of a
 *  box or zone, inside the bottom of a circle, under anything else. */
function ItemLabel({ it, fs }: { it: PlotItem; fs: number }) {
  const a = (it.rotation * Math.PI) / 180;
  const ex = (Math.abs(it.w * Math.cos(a)) + Math.abs(it.h * Math.sin(a))) / 2;
  const ey = (Math.abs(it.w * Math.sin(a)) + Math.abs(it.h * Math.cos(a))) / 2;
  const [cx, cy] = [it.x + it.w / 2, it.y + it.h / 2];
  if (it.type === "zone" || it.type === "box") {
    return (
      <Label x={cx - ex + fs * 0.6} y={cy - ey + fs * 1.4} fs={fs}>
        {it.label}
      </Label>
    );
  }
  if (it.type === "circle") {
    return (
      <Label x={cx} y={cy + ey - fs * 0.7} fs={fs} anchor="middle">
        {it.label}
      </Label>
    );
  }
  return (
    <Label x={cx} y={cy + ey + fs * 1.15} fs={fs} anchor="middle">
      {it.label}
    </Label>
  );
}

const PlotItemView = memo(function PlotItemView(props: ItemProps) {
  const { item: it, k, fs, selected, tapped, calloutNo, labels } = props;
  itemRenderProbe.current?.(it.id);
  const data = {
    "data-id": it.id,
    "data-testid": `item-${it.id}`,
    "data-type": it.type,
    "data-x": Math.round(it.x),
    "data-y": Math.round(it.y),
    "data-w": Math.round(it.w),
    "data-h": Math.round(it.h),
    "data-rot": Math.round(it.rotation),
  };
  if (it.type === "cable") {
    return (
      <g {...data}>
        <CableItem {...props} />
      </g>
    );
  }
  const [hw, hh] = [it.w / 2, it.h / 2];
  const frame = `translate(${r1(it.x + hw)} ${r1(it.y + hh)}) rotate(${it.rotation})`;
  return (
    <g {...data}>
      <g transform={frame}>
        {tapped && (
          <rect
            x={-hw - 8 * k}
            y={-hh - 8 * k}
            width={it.w + 16 * k}
            height={it.h + 16 * k}
            rx={r1(6 * k)}
            fill="none"
            strokeWidth={r1(2 * k)}
            style={{ stroke: ACCENT }}
          />
        )}
        {body(it, k, fs, calloutNo, labels)}
        <rect x={-hw} y={-hh} width={it.w} height={it.h} fill="transparent" />
      </g>
      {labels && it.label && it.type !== "text" && <ItemLabel it={it} fs={fs} />}
      {/* The handles after the label: a turned item's label can sit over a handle, and must not take its press. */}
      {selected && (
        <g transform={frame}>
          <Selection hw={hw} hh={hh} k={k} below={rotateHandleBelow(it, k)} />
        </g>
      )}
    </g>
  );
});

export interface PlotItemsProps {
  items: readonly PlotItem[];
  /** Plot units per screen pixel: how large one pixel of stroke or handle is. */
  k: number;
  /** Label size in screen pixels. */
  labelPx: number;
  /** The selected item, drawn last with its handles (the editor). */
  selectedId?: string | null;
  /** The item whose details are open, ringed (the read-only page). */
  tappedId?: string | null;
  /** False draws no labels: a thumbnail. */
  labels?: boolean;
}

export function PlotItems({ items, k, labelPx, selectedId = null, tappedId = null, labels = true }: PlotItemsProps) {
  const numbers = calloutNumbers(items);
  const fs = labelPx * k;
  return (
    <g data-items="">
      {drawOrder(items, selectedId).map((it) => (
        <PlotItemView
          key={it.id}
          item={it}
          k={k}
          fs={fs}
          selected={it.id === selectedId}
          tapped={it.id === tappedId}
          calloutNo={numbers.get(it.id)}
          labels={labels}
        />
      ))}
    </g>
  );
}
