// symbols.tsx — the nine symbol drawings and the palette icons for the other item
// types, as outline drawings in the app's Lucide icon style. Each has its own box:
// 24 x 24 for the icons, the item's footprint for a symbol (24 units tall, as wide
// as DEFAULT_SIZES makes it), so a symbol keeps its proportions wherever it is
// drawn. An entry commented "lucide:<name>" is that Lucide icon's own geometry;
// the rest are drawn for this project on Lucide's grid. From the approved
// icon-sheet mockup; keep the two in step.
//
// Lucide (lucide-react), for the entries commented "lucide:<name>":
//   ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
//   Permission to use, copy, modify, and/or distribute this software for any
//   purpose with or without fee is hereby granted, provided that the above
//   copyright notice and this permission notice appear in all copies.
// Of those, "circle" and "type" derive from Feather:
//   The MIT License (MIT). Copyright (c) 2013-present Cole Bemis.
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
// Both licences disclaim all warranties; full texts in node_modules/lucide-react/LICENSE.

import type { PlotItem, SymbolKind, TextKind } from "@main/types/stageplots";

export interface SymbolPart {
  el: "rect" | "circle" | "path";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rx?: number;
  cx?: number;
  cy?: number;
  r?: number;
  d?: string;
  transform?: string;
}

/** A drawing in a `box` of [width, height] units, outline only. */
export interface Drawing {
  box: readonly [number, number];
  parts: readonly SymbolPart[];
}

export interface SymbolDef extends Drawing {
  name: string;
}

const ICON_BOX = [24, 24] as const;
const path = (d: string): SymbolPart => ({ el: "path", d });

export const SYMBOLS: Record<SymbolKind, SymbolDef> = {
  // From above: kick, snare, two rack toms, floor tom, hi-hat, cymbal.
  drumkit: {
    name: "Drum kit",
    box: [27, 24],
    parts: [
      { el: "rect", x: 10.5, y: 12, width: 6, height: 9, rx: 1.5 },
      { el: "circle", cx: 6.5, cy: 15.5, r: 3 },
      { el: "circle", cx: 11, cy: 7, r: 2.5 },
      { el: "circle", cx: 16.5, cy: 7, r: 2.5 },
      { el: "circle", cx: 21.5, cy: 16, r: 3.5 },
      { el: "circle", cx: 3.5, cy: 8.5, r: 2.5 },
      { el: "circle", cx: 23, cy: 5.5, r: 2.5 },
    ],
  },
  // From above: the keybed, then the case curving to its tail.
  piano: {
    name: "Grand piano",
    box: [30, 24],
    parts: [
      { el: "rect", x: 3, y: 2, width: 24, height: 5, rx: 1 },
      path("M3 7h24v4c0 3-2.5 3.5-4.5 6.5S18 22 14 22H3z"),
      path("M8 2v3M13 2v3M18 2v3M23 2v3"),
    ],
  },
  keyboard: {
    name: "Keyboard",
    box: [65, 24],
    parts: [
      { el: "rect", x: 2, y: 4, width: 61, height: 16, rx: 2 },
      path("M2 10h61"),
      path("M10 10v5M18 10v5M26 10v5M34 10v5M42 10v5M50 10v5M58 10v5"),
    ],
  },
  wedge: {
    name: "Floor wedge",
    box: [42, 24],
    parts: [path("M3 21h36l-5-18H8z"), path("M7 15h28"), path("M8.6 9h24.8")],
  },
  // From the front: the control strip with two knobs, and the speaker.
  amp: {
    name: "Amp",
    box: [32, 24],
    parts: [
      { el: "rect", x: 2, y: 3, width: 28, height: 18, rx: 2 },
      path("M2 8h28"),
      path("M6 5.5h.01"),
      path("M10 5.5h.01"),
      { el: "circle", cx: 16, cy: 14.5, r: 4 },
    ],
  },
  // From above: three legs, and the boom out to the mic.
  micstand: {
    name: "Mic stand",
    box: [24, 24],
    parts: [
      path("M9 15 3 21"),
      path("m9 15 6 6"),
      path("M9 15v7"),
      path("M9 15 15 9"),
      { el: "rect", x: 15.5, y: 2, width: 5, height: 8, rx: 2.5, transform: "rotate(45 18 6)" },
    ],
  },
  // From above: three faders, a screen and two knobs.
  console: {
    name: "Console",
    box: [38, 24],
    parts: [
      { el: "rect", x: 2, y: 3, width: 34, height: 18, rx: 2 },
      path("M7.5 7v11M13 7v11M18.5 7v11"),
      path("M6 14h3M11.5 10h3M17 12h3"),
      { el: "rect", x: 23, y: 7, width: 9, height: 5, rx: 1 },
      path("M25 16h.01M30 16h.01"),
    ],
  },
  // From the front: tweeter over woofer.
  speaker: {
    name: "Speaker",
    box: [16.5, 24],
    parts: [
      { el: "rect", x: 2, y: 2, width: 12.5, height: 20, rx: 2 },
      { el: "circle", cx: 8.25, cy: 7, r: 1.5 },
      { el: "circle", cx: 8.25, cy: 15, r: 3.75 },
    ],
  },
  // From the side: body, lens, viewfinder.
  camera: {
    name: "Camera",
    box: [34, 24],
    parts: [
      { el: "rect", x: 2, y: 7, width: 20, height: 13, rx: 2 },
      path("m22 11.5 9-4v12l-9-4"),
      { el: "rect", x: 5, y: 3, width: 8, height: 4, rx: 1 },
    ],
  },
};

/** The palette's key for an item that is not a symbol: its type, or its text kind. */
export type IconKey = "box" | "circle" | "zone" | "cable" | "conn" | TextKind;

export const TYPE_ICONS: Record<IconKey, Drawing> = {
  // lucide:rectangle-horizontal
  box: { box: ICON_BOX, parts: [{ el: "rect", x: 2, y: 6, width: 20, height: 12, rx: 2 }] },
  // lucide:circle
  circle: { box: ICON_BOX, parts: [{ el: "circle", cx: 12, cy: 12, r: 10 }] },
  // lucide:square-dashed
  zone: {
    box: ICON_BOX,
    parts: [
      path("M5 3a2 2 0 0 0-2 2"),
      path("M19 3a2 2 0 0 1 2 2"),
      path("M21 19a2 2 0 0 1-2 2"),
      path("M5 21a2 2 0 0 1-2-2"),
      path("M9 3h1M14 3h1M9 21h1M14 21h1"),
      path("M3 9v1M3 14v1M21 9v1M21 14v1"),
    ],
  },
  // lucide:spline
  cable: {
    box: ICON_BOX,
    parts: [{ el: "circle", cx: 19, cy: 5, r: 2 }, { el: "circle", cx: 5, cy: 19, r: 2 }, path("M5 17A12 12 0 0 1 17 5")],
  },
  // The plot's connection point: a rounded square with its socket.
  conn: {
    box: ICON_BOX,
    parts: [{ el: "rect", x: 3, y: 3, width: 18, height: 18, rx: 4 }, { el: "circle", cx: 12, cy: 12, r: 4 }, path("M12 12h.01")],
  },
  // lucide:type
  label: { box: ICON_BOX, parts: [path("M12 4v16"), path("M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"), path("M9 20h6")] },
  // A numbered dot (Lucide has none).
  callout: { box: ICON_BOX, parts: [{ el: "circle", cx: 12, cy: 12, r: 10 }, path("M10 9.5 12.5 7.5v9")] },
  // lucide:ruler-dimension-line
  dimension: {
    box: ICON_BOX,
    parts: [
      path("M2 8V4M22 8V4M22 6H2"),
      path("M6 15v-3M10 15v-3M14 15v-3M18 15v-3"),
      { el: "rect", x: 2, y: 12, width: 20, height: 8, rx: 2 },
    ],
  },
};

/** What each non-symbol kind is called: the palette, the inspector and a tap's details. */
export const TYPE_NAMES: Record<IconKey, string> = {
  box: "Box",
  circle: "Circle",
  zone: "Zone",
  cable: "Cable",
  conn: "Connection point",
  label: "Label",
  callout: "Callout",
  dimension: "Dimension",
};

/** The palette key an item is drawn and listed under. */
export function iconKeyOf(it: Pick<PlotItem, "type" | "symbol" | "textKind">): IconKey | `sym:${SymbolKind}` {
  if (it.type === "symbol" && it.symbol) return `sym:${it.symbol}`;
  if (it.type === "text") return it.textKind ?? "label";
  return it.type as IconKey;
}

/** An item's palette icon. */
export function iconDrawing(key: IconKey | `sym:${SymbolKind}`): Drawing {
  return key.startsWith("sym:") ? SYMBOLS[key.slice(4) as SymbolKind] : TYPE_ICONS[key as IconKey];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The transform that draws `d` as large as fits in the w x h box at (x, y), centred,
 *  keeping its proportions. */
export function fitTransform(d: Drawing, x: number, y: number, w: number, h: number): string {
  const [bw, bh] = d.box;
  const s = Math.min(w / bw, h / bh);
  return `translate(${round3(x + (w - bw * s) / 2)} ${round3(y + (h - bh * s) / 2)}) scale(${round3(s)})`;
}

/** What an item is, as the inspector heads it: "Symbol · Drum kit", "Text · Callout", "Box". */
export function itemTypeName(it: Pick<PlotItem, "type" | "symbol" | "textKind">): string {
  if (it.type === "symbol" && it.symbol) return `Symbol · ${SYMBOLS[it.symbol].name}`;
  if (it.type === "text") return `Text · ${TYPE_NAMES[it.textKind ?? "label"]}`;
  return TYPE_NAMES[it.type as IconKey];
}

/** What an item is, short, for a tap's details: "Drum kit", "Connection point". */
export function itemKindName(it: Pick<PlotItem, "type" | "symbol" | "textKind">): string {
  return it.type === "symbol" && it.symbol ? SYMBOLS[it.symbol].name : itemTypeName(it);
}

/** A symbol as large as fits in the w x h box at (x, y), centred, in `color`, its
 *  line `strokeWidth` screen pixels at any scale. The plot and the legend draw it. */
export function SymbolDrawing({ kind, x, y, w, h, strokeWidth, color }: { kind: SymbolKind; x: number; y: number; w: number; h: number; strokeWidth: number; color: string }) {
  const def = SYMBOLS[kind];
  return (
    <g
      data-symbol={kind}
      transform={fitTransform(def, x, y, w, h)}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      strokeLinecap="round"
      style={{ color }}
      className="[&>*]:[vector-effect:non-scaling-stroke]"
    >
      {def.parts.map((p, i) => (
        <Part key={i} part={p} />
      ))}
    </g>
  );
}

/** One part of a symbol or icon drawing. */
export function Part({ part }: { part: SymbolPart }) {
  const { el, ...attrs } = part;
  if (el === "rect") return <rect {...attrs} />;
  if (el === "circle") return <circle {...attrs} />;
  return <path {...attrs} />;
}
