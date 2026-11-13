// symbols.ts — the nine symbol drawings and the palette icons for the other item
// types: original line drawings for this project, each in a 100 x 100 box. A
// part marked "faint" is filled at a low opacity, "solid" a little more.
// Generated from the approved mockup's SYM and TICON data; keep the two in step.
// Part draws one of them.

import type { CSSProperties } from "react";

import type { PlotItem, SymbolKind, TextKind } from "@main/types/stageplots";

export interface SymbolPart {
  el: "rect" | "circle" | "ellipse" | "path";
  fill?: "faint" | "solid";
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
  strokeDasharray?: string;
}

export interface SymbolDef {
  name: string;
  parts: readonly SymbolPart[];
}

export const SYMBOLS: Record<SymbolKind, SymbolDef> = {
  drumkit: {
    name: "Drum kit",
    parts: [
      { el: "rect", fill: "faint", x: 34, y: 50, width: 32, height: 26, rx: 5 },
      { el: "circle", cx: 24, cy: 63, r: 11 },
      { el: "circle", cx: 77, cy: 66, r: 13 },
      { el: "circle", cx: 40, cy: 35, r: 9 },
      { el: "circle", cx: 61, cy: 35, r: 9 },
      { el: "circle", cx: 12, cy: 42, r: 9 },
      { el: "circle", cx: 12, cy: 42, r: 2 },
      { el: "circle", cx: 24, cy: 15, r: 11 },
      { el: "circle", cx: 82, cy: 24, r: 13 },
      { el: "circle", cx: 50, cy: 92, r: 6 },
    ],
  },
  piano: {
    name: "Grand piano",
    parts: [
      { el: "path", fill: "faint", d: "M8 22H92V48C92 62 78 64 72 76C66 90 54 96 38 96H8Z" },
      { el: "rect", x: 8, y: 10, width: 84, height: 12 },
      { el: "path", d: "M20 10v7M32 10v7M44 10v7M56 10v7M68 10v7M80 10v7" },
      { el: "path", d: "M18 30 70 82" },
      { el: "rect", x: 34, y: 1, width: 32, height: 5, rx: 1.5 },
    ],
  },
  keyboard: {
    name: "Keyboard",
    parts: [
      { el: "rect", fill: "faint", x: 3, y: 22, width: 94, height: 56, rx: 4 },
      { el: "rect", x: 9, y: 44, width: 82, height: 26, rx: 1 },
      { el: "path", d: "M15 44v26M21 44v26M27 44v26M33 44v26M39 44v26M45 44v26M51 44v26M57 44v26M63 44v26M69 44v26M75 44v26M81 44v26M87 44v26" },
      { el: "circle", cx: 16, cy: 32, r: 3 },
      { el: "circle", cx: 27, cy: 32, r: 3 },
      { el: "rect", x: 60, y: 28, width: 28, height: 8, rx: 1 },
    ],
  },
  wedge: {
    name: "Floor wedge",
    parts: [
      { el: "path", fill: "faint", d: "M6 92H94L82 10H18Z" },
      { el: "path", d: "M14 74H86M16 60H84M18 46H82M20 32H80" },
    ],
  },
  amp: {
    name: "Amp",
    parts: [
      { el: "rect", fill: "faint", x: 6, y: 12, width: 88, height: 76, rx: 5 },
      { el: "path", d: "M6 30H94" },
      { el: "circle", cx: 18, cy: 21, r: 3 },
      { el: "circle", cx: 30, cy: 21, r: 3 },
      { el: "circle", cx: 42, cy: 21, r: 3 },
      { el: "circle", cx: 50, cy: 59, r: 22 },
      { el: "circle", cx: 50, cy: 59, r: 7 },
    ],
  },
  micstand: {
    name: "Mic stand",
    parts: [
      { el: "path", d: "M40 60 14 88M40 60 66 88M40 60 40 97" },
      { el: "circle", fill: "faint", cx: 40, cy: 60, r: 7 },
      { el: "path", d: "M40 60 78 24" },
      { el: "rect", fill: "faint", x: 74, y: 6, width: 14, height: 24, rx: 7, transform: "rotate(45 81 18)" },
    ],
  },
  console: {
    name: "Console",
    parts: [
      { el: "rect", fill: "faint", x: 3, y: 8, width: 94, height: 84, rx: 4 },
      { el: "rect", x: 36, y: 16, width: 28, height: 18, rx: 1.5 },
      { el: "path", d: "M12 52v32M20 52v32M28 52v32M36 52v32M44 52v32M56 52v32M64 52v32M72 52v32M80 52v32M88 52v32" },
      { el: "path", d: "M9 70h6M17 62h6M25 76h6M33 66h6M41 72h6M53 64h6M61 74h6M69 60h6M77 70h6M85 66h6" },
      { el: "circle", cx: 14, cy: 22, r: 3 },
      { el: "circle", cx: 24, cy: 22, r: 3 },
      { el: "circle", cx: 76, cy: 22, r: 3 },
      { el: "circle", cx: 86, cy: 22, r: 3 },
    ],
  },
  speaker: {
    name: "Speaker",
    parts: [
      { el: "rect", fill: "faint", x: 20, y: 4, width: 60, height: 92, rx: 5 },
      { el: "circle", cx: 50, cy: 24, r: 9 },
      { el: "circle", cx: 50, cy: 64, r: 22 },
      { el: "circle", cx: 50, cy: 64, r: 6 },
    ],
  },
  camera: {
    name: "Camera",
    parts: [
      { el: "rect", fill: "faint", x: 8, y: 30, width: 58, height: 42, rx: 5 },
      { el: "path", d: "M66 42 92 30V72L66 60Z" },
      { el: "rect", x: 16, y: 18, width: 22, height: 12, rx: 2 },
      { el: "circle", cx: 24, cy: 51, r: 6 },
    ],
  },
};

/** The palette's key for an item that is not a symbol: its type, or its text kind. */
export type IconKey = "box" | "circle" | "zone" | "cable" | "conn" | TextKind;

export const TYPE_ICONS: Record<IconKey, readonly SymbolPart[]> = {
  box: [
    { el: "rect", fill: "faint", x: 12, y: 24, width: 76, height: 52, rx: 6 },
  ],
  circle: [
    { el: "circle", fill: "faint", cx: 50, cy: 50, r: 34 },
  ],
  zone: [
    { el: "rect", fill: "faint", x: 10, y: 18, width: 80, height: 64, rx: 12, strokeDasharray: "12 9" },
  ],
  cable: [
    { el: "path", d: "M10 78C34 78 38 24 62 24S84 40 90 30", strokeDasharray: "14 10" },
  ],
  conn: [
    { el: "rect", fill: "solid", x: 26, y: 26, width: 48, height: 48, rx: 11 },
    { el: "circle", cx: 50, cy: 50, r: 10 },
  ],
  label: [
    { el: "path", d: "M24 22h52M50 22v58" },
  ],
  callout: [
    { el: "circle", fill: "faint", cx: 50, cy: 50, r: 32 },
    { el: "path", d: "M45 39l7-5v34" },
  ],
  dimension: [
    { el: "path", d: "M12 50h76M12 32v36M88 32v36M26 41 13 50l13 9M74 41l13 9-13 9" },
  ],
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

/** The parts of an item's palette icon. */
export function iconParts(key: IconKey | `sym:${SymbolKind}`): readonly SymbolPart[] {
  return key.startsWith("sym:") ? SYMBOLS[key.slice(4) as SymbolKind].parts : TYPE_ICONS[key as IconKey];
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

/** One part of a symbol or icon drawing. */
export function Part({ part }: { part: SymbolPart }) {
  const { el, fill, strokeDasharray, ...attrs } = part;
  const style: CSSProperties | undefined =
    fill === "faint" ? { fill: "currentColor", fillOpacity: 0.12 } : fill === "solid" ? { fill: "currentColor", fillOpacity: 0.35 } : undefined;
  const props = { ...attrs, style, ...(strokeDasharray ? { strokeDasharray } : {}) };
  if (el === "rect") return <rect {...props} />;
  if (el === "circle") return <circle {...props} />;
  if (el === "ellipse") return <ellipse {...props} />;
  return <path {...props} />;
}
