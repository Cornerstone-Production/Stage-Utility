import { useState, useEffect, useRef, useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  UndoIcon,
  Trash2Icon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  Grid3x3Icon,
  SaveIcon,
  DownloadIcon,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  PencilIcon,
  CheckIcon,
  LayoutTemplateIcon,
  CornerLeftUpIcon,
  LockIcon,
  UnlockIcon,
  PackagePlusIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Button,
  Input,
  NumberInput as UiNumberInput,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  ButtonGroup,
  Switch,
  Separator,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui";
import { ObjectContent, boxStyle, useLayoutData, loadProcessedAttachment, type LayoutRenderCtx } from "../../main/layout-renderer";
import {
  findById,
  mapById,
  removeById,
  getParentOf,
  getSiblings,
  insertChild,
  depthOf,
  forEachWithRect,
  composeRect,
  localizeRect,
  deepCloneFreshIds,
  isLockedInTree,
  type FracRect,
} from "../../main/layout-tree";
import { useSplState } from "../../main/use-spl-state";
import { usePeopleCountState } from "../../main/use-people-count-state";
import { useObsState } from "../../main/use-obs-state";
import { useOscTargets } from "../../main/use-osc-state";
import { useStageState } from "../../main/use-stage-state";
import { usePlanItems } from "../../main/use-plan-items";
import { invoke } from "../../lib/api";
import { InlineSlotsEditor } from "./inline-slots-editor";

// ── object metadata ──────────────────────────────────────────────────────────

const TYPE_LABELS: Record<LayoutObjectType, string> = {
  text: "Text",
  clock: "Clock",
  "countdown-timer": "Countdown timer",
  "current-slide-text": "Current slide",
  "next-slide-text": "Next slide",
  "current-service-item": "Current item",
  "next-service-item": "Next item",
  "service-order": "Service order",
  "current-slide-notes": "Slide notes",
  "slide-thumbnail": "Slide image",
  "section-chip": "Section chip",
  "slots-grid": "Mic slots",
  "transcript-strip": "Captions",
  "live-controls": "PCO Prev/Next",
  "charger-battery": "Charger battery",
  "spl-meter": "SPL meter",
  "obs-status": "OBS status",
  "osc-button": "OSC button",
  "people-counter": "People counter",
  "brand-logo": "Logo",
  "ndi-video": "NDI video",
  image: "Image",
  "plan-attachment": "Plan file",
  shape: "Shape",
  container: "Container",
};
const PALETTE: LayoutObjectType[] = [
  "container", "text", "clock", "countdown-timer", "live-controls", "current-slide-text", "next-slide-text",
  "current-service-item", "next-service-item", "service-order",
  "current-slide-notes", "slide-thumbnail", "section-chip", "slots-grid",
  "transcript-strip", "charger-battery", "spl-meter", "obs-status", "osc-button", "people-counter", "brand-logo", "image", "plan-attachment", "shape",
];

// Deepest allowed object depth (top-level = 0). A container holding objects = 1;
// a container holding containers holding leaves = 2. Keeps the editor sane.
const MAX_DEPTH = 2;

// The canvas occupies the whole coordinate space; top-level objects are fractions of it.
const CANVAS_FRAC: FracRect = { x: 0, y: 0, w: 1, h: 1 };

// Dashboard "glass tile" look, expressed in the style fields every object shares.
// Border/radius/padding are fractions of canvas HEIGHT (≈1px / 16px on a 1080 canvas).
// Reused by the container default style and the Phase C preset buttons.
type CardAccent = "neutral" | "green" | "red" | "amber" | "flat";
const CARD_PRESETS: Record<CardAccent, LayoutStyle> = {
  neutral: { background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  green: { background: "rgba(45,212,150,0.08)", borderColor: "rgba(45,212,150,0.13)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  red: { background: "rgba(229,72,77,0.10)", borderColor: "rgba(229,72,77,0.25)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  amber: { background: "rgba(255,197,61,0.08)", borderColor: "rgba(255,197,61,0.20)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  flat: { background: null, borderColor: null, borderWidth: 0, cornerRadius: 0, padding: 0 },
};

function defaultConfig(type: LayoutObjectType): LayoutObjectConfig {
  switch (type) {
    case "text": return { type: "text", text: "Text" };
    case "clock": return { type: "clock", showSeconds: true, format: "12h" };
    case "section-chip": return { type: "section-chip", which: "current" };
    case "slots-grid": return { type: "slots-grid", source: "inline", sourceViewId: null };
    case "transcript-strip": return { type: "transcript-strip", mode: "rolling" };
    case "charger-battery": return { type: "charger-battery", bays: [], show: { battery: true, charging: true } };
    case "spl-meter": return { type: "spl-meter", meterId: null, metricKey: null, showLabel: false, thresholds: null };
    case "obs-status": return { type: "obs-status", showTimecode: false, hideWhenIdle: false, fillWhenRecording: true };
    case "osc-button": return { type: "osc-button", targetId: null, label: "Button", address: "/", args: [], feedback: null };
    case "people-counter": return { type: "people-counter", metric: "attendance", zoneId: null, label: "People", showLabel: true };
    case "brand-logo": return { type: "brand-logo", useEmptySlotLogo: false };
    case "image": return { type: "image", src: "" };
    case "plan-attachment": return { type: "plan-attachment", match: "stage plot", page: 1 };
    case "shape": return { type: "shape", shape: "rect" };
    case "service-order": return { type: "service-order", noteCategories: null, showLength: false, highlightLive: true, scroll: "auto", autoFit: true };
    case "container": return { type: "container" };
    default: return { type } as LayoutObjectConfig;
  }
}

function defaultStyle(type: LayoutObjectType): LayoutStyle {
  if (type === "shape") return { background: "#3b82f6", opacity: 1 };
  if (type === "container") return { ...CARD_PRESETS.neutral };
  if (type === "ndi-video" || type === "slide-thumbnail" || type === "image" || type === "plan-attachment" || type === "brand-logo" || type === "live-controls") return {};
  // Captions read left-aligned and bottom-anchored, like the dedicated display.
  if (type === "transcript-strip") return { fontSize: 0.045, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "bottom" };
  if (type === "charger-battery") return { fontSize: 0.045, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "middle" };
  // Service order is a left-aligned, top-anchored list.
  if (type === "service-order") return { fontSize: 0.035, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "top" };
  // OBS status reads as a bold pill (glass when idle, fills red when recording).
  if (type === "obs-status") return { fontSize: 0.05, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true, ...CARD_PRESETS.neutral };
  // OSC button reads as a tappable pill.
  if (type === "osc-button") return { fontSize: 0.045, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", ...CARD_PRESETS.neutral };
  // People counter reads as a big bold number.
  if (type === "people-counter") return { fontSize: 0.12, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  return { fontSize: 0.06, fontWeight: 500, color: "#ffffff", textAlign: "center", vAlign: "middle" };
}

// crypto.randomUUID() only exists in a SECURE context (https / localhost). Kiosk
// servers run over plain HTTP on a LAN address, where it's undefined — calling it
// throws and silently aborts the click (the dropdown closes, nothing is added).
// getRandomValues is available everywhere; fall back further just in case.
function uid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeObject(
  type: LayoutObjectType,
  z: number,
  geom?: Partial<Pick<LayoutObject, "x" | "y" | "w" | "h">>,
): LayoutObject {
  // Containers default to a card-sized box; everything else keeps the old default.
  // (Top-level adds are snapped to the square grid by the caller via snapRectToGrid.)
  const base = type === "container" ? { x: 0.3, y: 0.32, w: 0.4, h: 0.32 } : { x: 0.35, y: 0.42, w: 0.3, h: 0.16 };
  return {
    id: uid(),
    ...base,
    ...geom,
    z,
    config: defaultConfig(type),
    style: defaultStyle(type),
  };
}

// Build the built-in "Dashboard" starter layout as editable nested objects: a
// 2×2 grid of glass tiles (clock / PCO timer / current + next item) plus SPL and
// captions strips, mirroring renderer/main/dashboard-view.tsx. All coords are
// canvas fractions, so it works on any canvas (designed for 16:9). Fresh ids.
function dashboardTemplate(): LayoutObject[] {
  let z = 0;
  const caption = (text: string): LayoutObject => ({
    id: uid(), x: 0.06, y: 0.1, w: 0.88, h: 0.2, z: 1,
    config: { type: "text", text },
    style: { fontSize: 0.022, fontWeight: 600, color: "#9ca3af", uppercase: true, letterSpacing: 0.1, textAlign: "center", vAlign: "middle" },
  });
  const body = (config: LayoutObjectConfig, color: string, fontSize: number): LayoutObject => ({
    id: uid(), x: 0.06, y: 0.34, w: 0.88, h: 0.56, z: 2,
    config, style: { fontSize, fontWeight: 500, color, textAlign: "center", vAlign: "middle" },
  });
  const tile = (x: number, y: number, w: number, h: number, cap: string, content: LayoutObject): LayoutObject => ({
    id: uid(), x, y, w, h, z: ++z, config: { type: "container" }, style: { ...CARD_PRESETS.neutral },
    children: [caption(cap), content],
  });
  const m = 0.02, g = 0.02;
  const colW = (1 - 2 * m - g) / 2;
  const x1 = m, x2 = m + colW + g;
  const rowH = 0.29, y1 = 0.03, y2 = y1 + rowH + g;
  return [
    tile(x1, y1, colW, rowH, "Current time", body({ type: "clock", showSeconds: true, format: "12h" }, "#ffffff", 0.09)),
    tile(x2, y1, colW, rowH, "Service timer", body({ type: "countdown-timer" }, "#7fe3c4", 0.09)),
    tile(x1, y2, colW, rowH, "Now", body({ type: "current-service-item" }, "#ffffff", 0.05)),
    tile(x2, y2, colW, rowH, "Up next", body({ type: "next-service-item" }, "rgba(255,255,255,0.7)", 0.05)),
    {
      id: uid(), x: m, y: 0.65, w: 1 - 2 * m, h: 0.13, z: ++z,
      config: { type: "container" }, style: { ...CARD_PRESETS.neutral },
      children: [
        { id: uid(), x: 0.02, y: 0.25, w: 0.12, h: 0.5, z: 1, config: { type: "text", text: "SPL" }, style: { fontSize: 0.03, fontWeight: 600, color: "#9ca3af", uppercase: true, letterSpacing: 0.1, textAlign: "left", vAlign: "middle" } },
        { id: uid(), x: 0.15, y: 0.15, w: 0.83, h: 0.7, z: 2, config: { type: "spl-meter", meterId: null, metricKey: null, showLabel: true, thresholds: null }, style: { fontSize: 0.07, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "middle" } },
      ],
    },
    {
      id: uid(), x: m, y: 0.8, w: 1 - 2 * m, h: 0.17, z: ++z,
      config: { type: "container" }, style: { ...CARD_PRESETS.neutral },
      children: [
        { id: uid(), x: 0.03, y: 0.12, w: 0.94, h: 0.76, z: 1, config: { type: "transcript-strip", mode: "rolling", maxLines: 2 }, style: { fontSize: 0.04, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "bottom" } },
      ],
    },
  ];
}

const GRID = 48; // snap steps across the canvas
const MIN = 0.03;

// Canvas aspect presets. Resolution is irrelevant (the renderer scales the design
// canvas to fit any screen, incl. 4K) — only the aspect/orientation matters.
const CANVAS_PRESETS: { id: string; label: string; w: number; h: number }[] = [
  { id: "16:9", label: "Landscape · 16:9", w: 1920, h: 1080 },
  { id: "9:16", label: "Portrait · 9:16", w: 1080, h: 1920 },
  { id: "4:3", label: "Standard · 4:3", w: 1440, h: 1080 },
  { id: "16:10", label: "Widescreen · 16:10", w: 1920, h: 1200 },
  { id: "21:9", label: "Ultrawide · 21:9", w: 2560, h: 1080 },
  { id: "32:9", label: "Super ultrawide · 32:9", w: 3840, h: 1080 },
  { id: "1:1", label: "Square · 1:1", w: 1080, h: 1080 },
  { id: "3:2", label: "3:2", w: 1620, h: 1080 },
  { id: "5:4", label: "5:4", w: 1350, h: 1080 },
];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// A native <input type="color"> only accepts solid "#rrggbb". Style colors can be
// translucent rgba() (the glass presets), #rgb, #rrggbbaa, var(), or named — so
// coerce to a solid hex for the swatch's value (dropping alpha) to avoid the
// browser's "does not conform to #rrggbb" warning. The stored style keeps its
// original value until the user picks a new one.
function hexForInput(v: string | null | undefined, fallback: string): string {
  if (!v) return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  const m3 = v.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  const m8 = v.match(/^#([0-9a-fA-F]{6})[0-9a-fA-F]{2}$/);
  if (m8) return `#${m8[1]}`;
  const rgb = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const h = (n: number) => clamp(n, 0, 255).toString(16).padStart(2, "0");
    return `#${h(+rgb[1])}${h(+rgb[2])}${h(+rgb[3])}`;
  }
  return fallback;
}

// Grid step per axis. x is a plain fraction of width (1/GRID); y is scaled by the
// canvas aspect so the cell is the SAME number of px on both axes (a SQUARE grid),
// regardless of canvas shape. Snapping uses these so objects land on the lines you
// see — including objects nested in a container (snapping is done in absolute
// canvas space, then converted back to the parent's local coords).
// Derive grid units from the actual rendered box aspect (boxW/boxH) so the snap
// grid matches the SQUARE grid drawn on that box — correct whether the canvas is
// letterboxed (box aspect == design aspect) or fills the window (box aspect ==
// window aspect).
function gridUnits(boxW: number, boxH: number): { xUnit: number; yUnit: number } {
  return { xUnit: 1 / GRID, yUnit: boxH > 0 ? (boxW / boxH) / GRID : 1 / GRID };
}
const snapTo = (v: number, unit: number) => Math.round(v / unit) * unit;

// Snap a parent-LOCAL rect to the grid. Composes to absolute, snaps x/y (and w/h
// when `size`), then localizes back so nested objects align to the same visible
// grid as top-level ones. `boxW`/`boxH` are the rendered canvas box dimensions.
function snapRectToGrid(
  local: FracRect,
  parentAbs: FracRect,
  boxW: number,
  boxH: number,
  size: boolean,
): FracRect {
  const { xUnit, yUnit } = gridUnits(boxW, boxH);
  const abs = composeRect(parentAbs, local);
  const snapped = {
    x: snapTo(abs.x, xUnit),
    y: snapTo(abs.y, yUnit),
    w: size ? Math.max(xUnit, snapTo(abs.w, xUnit)) : abs.w,
    h: size ? Math.max(yUnit, snapTo(abs.h, yUnit)) : abs.h,
  };
  return localizeRect(parentAbs, snapped);
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function handleCursor(h: Handle): string {
  if (h === "n" || h === "s") return "ns-resize";
  if (h === "e" || h === "w") return "ew-resize";
  if (h === "nw" || h === "se") return "nwse-resize";
  return "nesw-resize";
}

function applyResize(start: LayoutObject, h: Handle, dx: number, dy: number): Pick<LayoutObject, "x" | "y" | "w" | "h"> {
  let { x, y, w, h: hh } = start;
  if (h.includes("e")) w = start.w + dx;
  if (h.includes("s")) hh = start.h + dy;
  if (h.includes("w")) { x = start.x + dx; w = start.w - dx; }
  if (h.includes("n")) { y = start.y + dy; hh = start.h - dy; }
  if (w < MIN) { if (h.includes("w")) x = start.x + start.w - MIN; w = MIN; }
  if (hh < MIN) { if (h.includes("n")) y = start.y + start.h - MIN; hh = MIN; }
  x = clamp(x, 0, 1 - w);
  y = clamp(y, 0, 1 - hh);
  w = Math.min(w, 1 - x);
  hh = Math.min(hh, 1 - y);
  return { x, y, w, h: hh };
}

// Recursive visual render for the editor canvas. Mirrors the renderer's
// RenderObject but DIMS hidden objects (by their own flag only) instead of
// removing them, so the editor still shows hidden layers faintly.
function EditorObject({ o, ctx }: { o: LayoutObject; ctx: LayoutRenderCtx }) {
  const kids = o.children?.length ? [...o.children].sort((a, b) => a.z - b.z) : null;
  return (
    <div
      style={{
        position: "absolute",
        left: `${o.x * 100}%`, top: `${o.y * 100}%`,
        width: `${o.w * 100}%`, height: `${o.h * 100}%`,
        ...boxStyle(o, ctx.H),
        opacity: (o.style?.opacity ?? 1) * (o.hidden ? 0.25 : 1),
      }}
    >
      {kids ? kids.map((c) => <EditorObject key={c.id} o={c} ctx={ctx} />) : <ObjectContent o={o} ctx={ctx} />}
    </div>
  );
}

// Flatten the tree (parents before children, each scope by z desc) into rows with
// a depth, for the indented Layers panel.
function flattenLayers(nodes: LayoutObject[], depth = 0): { o: LayoutObject; depth: number }[] {
  const out: { o: LayoutObject; depth: number }[] = [];
  for (const o of [...nodes].sort((a, b) => b.z - a.z)) {
    out.push({ o, depth });
    if (o.children?.length) out.push(...flattenLayers(o.children, depth + 1));
  }
  return out;
}

// A container drop target captured at drag start (containers don't move while a
// single object is dragged, so a start snapshot is valid for the whole drag).
interface DropTarget {
  id: string;
  abs: FracRect;
  depth: number;
}

// Pick the most specific (smallest) container whose box contains the point and
// that can legally accept the dragged object without exceeding the depth cap.
function findDropContainer(targets: DropTarget[], draggedIsContainer: boolean, cx: number, cy: number): string | null {
  const hits = targets.filter((t) => {
    const inside = cx >= t.abs.x && cx <= t.abs.x + t.abs.w && cy >= t.abs.y && cy <= t.abs.y + t.abs.h;
    if (!inside) return false;
    // A leaf may nest under a depth-0 or depth-1 container (child ends at depth ≤2).
    // A container may only nest under a depth-0 container (its leaves end at depth ≤2).
    return draggedIsContainer ? t.depth === 0 : t.depth <= 1;
  });
  hits.sort((a, b) => a.abs.w * a.abs.h - b.abs.w * b.abs.h);
  return hits[0]?.id ?? null;
}

// ── canvas with interactive overlay ──────────────────────────────────────────

interface DragState {
  id: string;
  mode: "move" | Handle;
  start: LayoutObject;
  px: number;
  py: number;
  /** Rendered px size of the dragged object's PARENT box (canvas for top-level). */
  parentW: number;
  parentH: number;
  /** Absolute (canvas-space) rect of the parent — for snapping in canvas space. */
  parentAbs: FracRect;
  /** Nesting depth of the dragged object (top-level = 0). */
  depth: number;
  /** Only top-level objects can be dropped into a container. */
  canReparent: boolean;
  /** Container drop targets captured at drag start. */
  targets: DropTarget[];
}

// One overlay box (selection outline + move/resize handles), positioned in % of
// its parent overlay node so nested children resolve correctly. Recurses for a
// container's children.
function OverlayNode({
  o, parentAbs, depth, selectedId, onStart, parentLocked = false,
}: {
  o: LayoutObject;
  parentAbs: FracRect;
  depth: number;
  selectedId: string | null;
  onStart: (e: ReactPointerEvent, o: LayoutObject, mode: "move" | Handle, parentAbs: FracRect, depth: number) => void;
  /** True when an ancestor container is locked, so this node is locked too. */
  parentLocked?: boolean;
}) {
  const sel = o.id === selectedId;
  const locked = parentLocked || !!o.locked;
  const abs = depth === 0 ? { x: o.x, y: o.y, w: o.w, h: o.h } : composeRect(parentAbs, o);
  const kids = o.children?.length ? [...o.children].sort((a, b) => a.z - b.z) : null;
  return (
    <div
      onPointerDown={(e) => onStart(e, o, "move", parentAbs, depth)}
      className="absolute"
      style={{
        left: `${o.x * 100}%`, top: `${o.y * 100}%`,
        width: `${o.w * 100}%`, height: `${o.h * 100}%`,
        cursor: locked ? "default" : "move",
        outline: sel ? "2px solid #3b82f6" : "1px solid rgba(125,170,255,0.55)",
        outlineOffset: 0,
        boxShadow: sel ? "0 0 0 1px rgba(0,0,0,0.4)" : "0 0 0 1px rgba(0,0,0,0.35)",
      }}
    >
      <span
        style={{
          position: "absolute", top: 0, left: 0, transform: "translateY(-100%)",
          display: "inline-flex", alignItems: "center", gap: 3,
          fontSize: 10, lineHeight: "14px", padding: "0 5px", maxWidth: "100%",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          background: sel ? "#3b82f6" : "rgba(125,170,255,0.55)", color: "#fff",
          borderRadius: "4px 4px 0 0", pointerEvents: "none",
        }}
      >
        {locked && <LockIcon style={{ width: 9, height: 9 }} />}
        {TYPE_LABELS[o.config.type]}
      </span>
      {sel && !locked &&
        HANDLES.map((h) => {
          const pos: CSSProperties = { position: "absolute", width: 9, height: 9, background: "#3b82f6", borderRadius: 2 };
          if (h.includes("n")) pos.top = -5;
          if (h.includes("s")) pos.bottom = -5;
          if (h.includes("w")) pos.left = -5;
          if (h.includes("e")) pos.right = -5;
          if (h === "n" || h === "s") pos.left = "calc(50% - 4.5px)";
          if (h === "e" || h === "w") pos.top = "calc(50% - 4.5px)";
          return <div key={h} onPointerDown={(e) => onStart(e, o, h, parentAbs, depth)} style={{ ...pos, cursor: handleCursor(h) }} />;
        })}
      {kids?.map((c) => (
        <OverlayNode key={c.id} o={c} parentAbs={abs} depth={depth + 1} selectedId={selectedId} onStart={onStart} parentLocked={locked} />
      ))}
    </div>
  );
}

function EditorCanvas({
  canvas, objects, selectedId, gridOn, ctx, ndiSource, interactive,
  onSelect, onGeom, onCommitStart, onReparent, onBoxSize,
}: {
  canvas: LayoutCanvas;
  objects: LayoutObject[];
  selectedId: string | null;
  gridOn: boolean;
  ctx: Omit<LayoutRenderCtx, "H" | "ndiSource" | "interactive">;
  ndiSource: string | null;
  /** When false the canvas is a read-only preview (no overlay, handles, or drag). */
  interactive: boolean;
  onSelect: (id: string | null) => void;
  onGeom: (id: string, geom: Pick<LayoutObject, "x" | "y" | "w" | "h">) => void;
  onCommitStart: () => void;
  /** Reports the rendered canvas box size so the parent's snap actions (Snap all /
   *  Snap to grid) use the same grid aspect as the canvas. */
  onBoxSize?: (w: number, h: number) => void;
  /** Drop a top-level object into a container (reparent on drag release).
   *  `objAbs` is the object's final absolute canvas rect; `containerAbs` the
   *  container's absolute rect — together they give the new parent-local geom. */
  onReparent: (id: string, containerId: string, objAbs: FracRect, containerAbs: FracRect) => void;
}) {
  // Measure the available area (this wrapper), then letterbox the design canvas to
  // fit BOTH axes so it never overflows on ultrawide/portrait/short screens.
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!wrap) return;
    // Measure from the live bounding rect (not clientWidth, which can lag a
    // responsive reflow). Re-measure on the next frame + after a short settle, and
    // on window resize, so boxW always tracks the REAL column width — otherwise a
    // stale (too-wide) value makes the grid/content/overlay layers size larger than
    // the box and drift off the grid.
    const m = () => {
      const r = wrap.getBoundingClientRect();
      setAvail((prev) =>
        Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
          ? prev
          : { w: r.width, h: r.height },
      );
    };
    m();
    const raf = requestAnimationFrame(m);
    const t = setTimeout(m, 80);
    const ro = new ResizeObserver(m);
    ro.observe(wrap);
    window.addEventListener("resize", m);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
      ro.disconnect();
      window.removeEventListener("resize", m);
    };
  }, [wrap]);

  // "fill" mode: the canvas fills the whole editor pane (objects reflow, just like
  // on a display set to fill) instead of letterboxing the design aspect.
  const fill = canvas.fit === "fill";
  const scale = avail.w > 0 && avail.h > 0 ? Math.min(avail.w / canvas.width, avail.h / canvas.height) : 0;
  const boxW = fill ? avail.w : canvas.width * scale;
  const boxH = fill ? avail.h : canvas.height * scale;
  // Report the box size up so parent snap actions use the same grid aspect.
  useEffect(() => {
    if (boxW > 0 && boxH > 0) onBoxSize?.(boxW, boxH);
    // onBoxSize is a stable useCallback from the parent; deps are the sizes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxW, boxH]);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Latest local geom set during the active drag (so pointerup can hit-test the
  // drop without depending on the parent's async state update).
  const dragGeom = useRef<Pick<LayoutObject, "x" | "y" | "w" | "h"> | null>(null);

  // Window-level move/up while dragging.
  useEffect(() => {
    if (!drag || boxW <= 0) return;
    // Deltas are fractions of the dragged object's PARENT box. Snapping is done in
    // ABSOLUTE canvas space (snapRectToGrid), so objects nested in a container land
    // on the same visible grid as top-level ones.
    const onMove = (e: globalThis.PointerEvent) => {
      const dx = (e.clientX - drag.px) / drag.parentW;
      const dy = (e.clientY - drag.py) / drag.parentH;
      let geom: Pick<LayoutObject, "x" | "y" | "w" | "h">;
      if (drag.mode === "move") {
        const local = { x: drag.start.x + dx, y: drag.start.y + dy, w: drag.start.w, h: drag.start.h };
        const snapped = gridOn ? snapRectToGrid(local, drag.parentAbs, boxW, boxH, false) : local;
        geom = { x: clamp(snapped.x, 0, 1 - drag.start.w), y: clamp(snapped.y, 0, 1 - drag.start.h), w: drag.start.w, h: drag.start.h };
      } else {
        const g = applyResize(drag.start, drag.mode, dx, dy);
        geom = gridOn ? snapRectToGrid(g, drag.parentAbs, boxW, boxH, true) : g;
      }
      dragGeom.current = geom;
      onGeom(drag.id, geom);
    };
    const onUp = () => {
      const g = dragGeom.current;
      // Only a top-level object dropped onto a container reparents into it.
      if (drag.mode === "move" && drag.canReparent && g) {
        const cx = g.x + g.w / 2;
        const cy = g.y + g.h / 2;
        const target = findDropContainer(drag.targets, drag.start.config.type === "container", cx, cy);
        const t = target ? drag.targets.find((x) => x.id === target) : null;
        // A top-level object's local geom IS its absolute canvas rect.
        if (t) onReparent(drag.id, t.id, { x: g.x, y: g.y, w: g.w, h: g.h }, t.abs);
      }
      dragGeom.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, boxW, boxH, gridOn, canvas, onGeom, onReparent]);

  function startDrag(e: ReactPointerEvent, o: LayoutObject, mode: "move" | Handle, parentAbs: FracRect, depth: number) {
    e.stopPropagation();
    e.preventDefault();
    onSelect(o.id);
    // Locked objects (and anything inside a locked container) select but never move.
    if (isLockedInTree(objects, o.id)) return;
    onCommitStart();
    // Snapshot container drop targets, excluding the dragged object and its own
    // subtree (can't drop a container into itself or its descendant) and any locked
    // container (so nothing can be dropped INTO a locked container either).
    const excluded = new Set<string>();
    const dragged = findById(objects, o.id);
    const collect = (n: LayoutObject) => { excluded.add(n.id); n.children?.forEach(collect); };
    if (dragged) collect(dragged);
    const targets: DropTarget[] = [];
    forEachWithRect(objects, (n) => {
      if (n.o.config.type === "container" && !excluded.has(n.o.id) && !isLockedInTree(objects, n.o.id)) targets.push({ id: n.o.id, abs: n.abs, depth: n.depth });
    });
    dragGeom.current = { x: o.x, y: o.y, w: o.w, h: o.h };
    setDrag({
      id: o.id, mode, start: o, px: e.clientX, py: e.clientY,
      parentW: parentAbs.w * boxW, parentH: parentAbs.h * boxH,
      parentAbs, depth, canReparent: depth === 0, targets,
    });
  }

  const sorted = [...objects].sort((a, b) => a.z - b.z);
  // Editor canvas is never interactive — live-control objects render as static
  // previews here so editing can't fire real PCO commands.
  const fullCtx: LayoutRenderCtx = { ...ctx, H: fill ? boxH : canvas.height, ndiSource, interactive: false };

  // Grid is drawn as its own overlay layer (below) that shares the EXACT box of the
  // scaled content layer — so cells and object coords line up regardless of the
  // canvas box's 1px border / border-box sizing. SQUARE cells (same px on both
  // axes) so the lines match the snap step exactly on any canvas shape.
  const cellPx = boxW / GRID;
  const gridLayer: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: boxW,
    height: boxH,
    pointerEvents: "none",
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
    backgroundSize: `${cellPx}px ${cellPx}px`,
  };

  return (
    <div ref={setWrap} className="relative w-full h-full flex items-start justify-center select-none">
      {boxW > 0 && boxH > 0 && (
        <div
          className="relative overflow-hidden rounded-xl"
          style={{
            width: boxW,
            height: boxH,
            // Frame drawn as an INSET shadow, not a border: a real border + the
            // global border-box sizing would shrink the padding box, so the
            // `inset-0` overlay (selection boxes + resize handles) would sit in a
            // box 2px narrower than the grid/content layers and drift off the grid
            // toward the right/bottom. An inset shadow frames it without changing
            // the box, so overlay, grid, and content share one coordinate space.
            boxShadow: "inset 0 0 0 1px var(--gray-a4)",
            // Mirror the kiosk: default/legacy backgrounds show the shared kiosk
            // surface so the editor preview matches every other view.
            background:
              canvas.background == null ||
              ["#000", "#000000", "#080810", "#0a0a0a"].includes(canvas.background)
                ? "var(--kiosk-bg)"
                : canvas.background,
          }}
          onPointerDown={interactive ? () => onSelect(null) : undefined}
        >
          {gridOn && <div style={gridLayer} />}
          {/* Content layer (visual only). Letterbox: design dims scaled. Fill: the
              layer IS the box (objects positioned by % of the live box). */}
          <div
            style={
              fill
                ? { width: boxW, height: boxH, position: "absolute", top: 0, left: 0, pointerEvents: "none" }
                : {
                    width: canvas.width, height: canvas.height,
                    transform: `scale(${scale})`, transformOrigin: "top left",
                    position: "absolute", top: 0, left: 0, pointerEvents: "none",
                  }
            }
          >
            {sorted.map((o) => (
              <EditorObject key={o.id} o={o} ctx={fullCtx} />
            ))}
          </div>

          {/* Interaction overlay (rendered px) — edit mode only. Recursive so a
              container's children are individually selectable/draggable; the
              overlay is unclipped so name-tags and handles stay visible. MUST use
              the same explicit boxW×boxH as the grid + content layers (NOT
              `inset-0`): if the outer box is ever flex-shrunk below boxW, inset-0
              would fill the shrunk box and the overlay would scale differently
              from the grid/content, so selection boxes + handles would drift off
              the grid. */}
          {interactive && (
            <div style={{ position: "absolute", top: 0, left: 0, width: boxW, height: boxH }}>
              {sorted.map((o) => (
                <OverlayNode
                  key={o.id}
                  o={o}
                  parentAbs={CANVAS_FRAC}
                  depth={0}
                  selectedId={selectedId}
                  onStart={startDrag}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── small inspector row helpers ──────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-caption2 text-gray-9 w-20 shrink-0">{label}</span>
      <div className="flex-1 min-w-0 flex items-center gap-1">{children}</div>
    </div>
  );
}

/** Thin wrappers over the shared themed NumberInput (kept so existing call sites
 *  and PixelField don't change). */
function NumberField({ value, onChange, step = 1, min, max, suffix }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return <UiNumberInput value={Number.isFinite(value) ? value : 0} onChange={onChange} step={step} min={min} max={max} suffix={suffix} />;
}

/** Style-row number (fraction value). */
function NumberInput({ value, onChange, step = 0.01, min, max }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return <NumberField value={Number.isFinite(value) ? value : 0} onChange={onChange} step={step} min={min} max={max} />;
}

/** X/Y/W/H field shown as whole design-canvas pixels (stored as a 0..1 fraction). */
function PixelField({ label, value, dim, onChange }: { label: string; value: number; dim: number; onChange: (frac: number) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-caption2 text-gray-9 w-3.5 shrink-0">{label}</span>
      <NumberField
        value={Math.round((Number.isFinite(value) ? value : 0) * dim)}
        step={1}
        min={0}
        max={dim}
        suffix="px"
        onChange={(v) => onChange(v / dim)}
      />
    </label>
  );
}

// ── main editor ──────────────────────────────────────────────────────────────

export function LayoutEditor({
  view,
  slotsViews,
  templates,
  onSave,
  onSaveTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
}: {
  view: View;
  slotsViews: View[];
  templates: LayoutTemplate[];
  onSave: (layout: LayoutDTO) => Promise<void>;
  onSaveTemplate: (name: string, layout: LayoutDTO) => Promise<void>;
  onUpdateTemplate: (id: string, patch: { name?: string; layout?: LayoutDTO }) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
}) {
  const data = useLayoutData();
  // background: null → inherits the shared kiosk surface (matches every other view).
  const initial = view.layout ?? { version: 1 as const, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
  const [canvas, setCanvas] = useState<LayoutCanvas>(initial.canvas);
  const [objects, setObjects] = useState<LayoutObject[]>(initial.objects);
  const [selectedId, setSelectedId] = useState<string | null>(initial.objects[0]?.id ?? null);
  const [history, setHistory] = useState<LayoutObject[][]>([]);
  const [dirty, setDirty] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tplName, setTplName] = useState("");
  // Rendered canvas box size (reported by EditorCanvas) — so the Snap actions use
  // the same grid aspect the canvas actually draws (matters in fill mode).
  const [editorBox, setEditorBox] = useState({ w: 0, h: 0 });
  const handleBoxSize = useCallback(
    (w: number, h: number) => setEditorBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h })),
    [],
  );
  // View-only by default: a custom view opens as a clean preview until "Edit" is
  // clicked, so a stray drag on a live display's layout can't mutate it.
  const [isEditing, setIsEditing] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Reusable object/container groups (loaded from the global library).
  const [groups, setGroups] = useState<LayoutGroup[]>([]);
  const [groupDlgOpen, setGroupDlgOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  useEffect(() => {
    invoke<LayoutGroup[]>("layoutGroups:list").then(setGroups).catch(() => setGroups([]));
  }, []);

  // Size the canvas to its own aspect-ratio height, derived from the canvas cell's
  // WIDTH (capped at the viewport). This gives the canvas a definite height — so it
  // can't collapse inside the Radix ScrollArea (whose content-sized wrapper breaks
  // `h-full`) and can't jump when a taller inspector grows the row — while keeping
  // the row only as tall as the preview, so anything below it (the inline mic-slots
  // editor) sits right underneath instead of after a viewport-tall gap. Width/top
  // don't depend on the height we set, so this isn't circular.
  const canvasCellRef = useRef<HTMLDivElement>(null);
  const [canvasH, setCanvasH] = useState<number | null>(null);
  useEffect(() => {
    const el = canvasCellRef.current;
    if (!el) return;
    const aspect = canvas.width / canvas.height;
    // In fill mode the canvas fills the available height (no design aspect).
    const fillMode = canvas.fit === "fill";
    const measure = () => {
      const width = el.clientWidth;
      const top = el.getBoundingClientRect().top;
      const maxH = Math.max(240, window.innerHeight - top - 16);
      const fit = width > 0 ? width / aspect : maxH;
      setCanvasH(Math.round(fillMode ? maxH : Math.min(fit, maxH)));
    };
    measure();
    window.addEventListener("resize", measure);
    // Observe the row (parent) for width changes; not `el` itself (we set its height).
    const ro = new ResizeObserver(measure);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => { window.removeEventListener("resize", measure); ro.disconnect(); };
  }, [isEditing, canvas.width, canvas.height, canvas.fit]);

  const currentLayout = (): LayoutDTO => ({ version: 1, canvas, objects });

  function discardChanges() {
    setObjects(initial.objects);
    setCanvas(initial.canvas);
    setSelectedId(initial.objects[0]?.id ?? null);
    setHistory([]);
    setDirty(false);
  }

  // Leaving edit mode: confirm if there are unsaved changes, else just exit.
  function leaveEditMode() {
    if (dirty) setConfirmLeave(true);
    else setIsEditing(false);
  }
  function loadTemplate(t: LayoutTemplate) {
    pushHistory();
    setObjects(t.layout.objects.map((o) => deepCloneFreshIds(o, uid)));
    setSelectedId(null);
    setDirty(true);
  }
  // Replace the layout with the built-in dashboard starter (editable nested tiles).
  function startFromDashboard() {
    pushHistory();
    setObjects(dashboardTemplate());
    setSelectedId(null);
    setDirty(true);
  }

  // Snap EVERY object (position + size, recursively) onto the grid in one click —
  // for cleaning up existing layouts whose objects predate grid snapping. Locked
  // objects/subtrees are left untouched.
  function snapAllToGrid() {
    const { xUnit, yUnit } = gridUnits(editorBox.w || canvas.width, editorBox.h || canvas.height);
    const snapNode = (o: LayoutObject, parentAbs: FracRect, ancestorLocked: boolean): LayoutObject => {
      if (ancestorLocked || o.locked) return o; // respect locks
      const abs = composeRect(parentAbs, { x: o.x, y: o.y, w: o.w, h: o.h });
      const snappedAbs = {
        x: snapTo(abs.x, xUnit),
        y: snapTo(abs.y, yUnit),
        w: Math.max(xUnit, snapTo(abs.w, xUnit)),
        h: Math.max(yUnit, snapTo(abs.h, yUnit)),
      };
      const local = localizeRect(parentAbs, snappedAbs);
      return {
        ...o,
        x: local.x, y: local.y, w: local.w, h: local.h,
        children: o.children?.map((c) => snapNode(c, snappedAbs, false)),
      };
    };
    pushHistory();
    setObjects((prev) => prev.map((o) => snapNode(o, CANVAS_FRAC, false)));
    setDirty(true);
  }

  // ── Reusable groups (save the selected container; insert a saved group) ──
  async function saveSelectedAsGroup() {
    const sel = findById(objects, selectedId);
    if (!sel) return;
    try {
      const list = await invoke<LayoutGroup[]>("layoutGroups:save", { name: groupName.trim() || "Group", object: sel });
      setGroups(list);
    } catch { /* ignore */ }
    setGroupDlgOpen(false);
    setGroupName("");
  }
  async function deleteGroup(id: string) {
    try {
      const list = await invoke<LayoutGroup[]>("layoutGroups:delete", { id });
      setGroups(list);
    } catch { /* ignore */ }
  }
  function insertGroup(g: LayoutGroup) {
    pushHistory();
    const copy = { ...deepCloneFreshIds(g.object, uid), z: zTop + 1 };
    setObjects((prev) => [...prev, copy]);
    setSelectedId(copy.id);
    setDirty(true);
  }

  const selected = findById(objects, selectedId);
  // The selected object iff it's an inline mic-slots grid (config narrowed so the
  // inline slot editor below the canvas gets its id + alignment).
  const inlineGrid =
    selected && selected.config.type === "slots-grid" && (selected.config.source ?? "view") === "inline"
      ? { id: selected.id, config: selected.config }
      : null;
  // Max z among the TOP-LEVEL scope (for adding/duplicating top-level objects).
  const zTop = objects.reduce((m, o) => Math.max(m, o.z), 0);

  // Absolute (canvas-space) rect of the selected object's PARENT — the canvas for
  // a top-level object, or the containing container's box for a nested child. Used
  // to show position/size in parent-relative px and to reparent the child out.
  let selParentAbs: FracRect = { x: 0, y: 0, w: 1, h: 1 };
  const selDepth = selected ? depthOf(objects, selected.id) : 0;
  if (selected && selDepth > 0) {
    const parent = getParentOf(objects, selected.id);
    if (parent) forEachWithRect(objects, (n) => { if (n.o.id === parent.id) selParentAbs = n.abs; });
  }

  const pushHistory = useCallback(() => {
    setHistory((h) => [...h.slice(-49), objects]);
    setDirty(true);
  }, [objects]);

  function update(id: string, patch: Partial<LayoutObject>) {
    setObjects((prev) => mapById(prev, id, (o) => ({ ...o, ...patch })));
  }
  function updateStyle(id: string, patch: Partial<LayoutStyle>) {
    setObjects((prev) => mapById(prev, id, (o) => ({ ...o, style: { ...o.style, ...patch } })));
  }
  function updateConfig(id: string, config: LayoutObjectConfig) {
    setObjects((prev) => mapById(prev, id, (o) => ({ ...o, config })));
  }
  // Geometry updates during a drag don't each push history (startDrag already did).
  const onGeom = useCallback((id: string, geom: Pick<LayoutObject, "x" | "y" | "w" | "h">) => {
    setObjects((prev) => mapById(prev, id, (o) => ({ ...o, ...geom })));
    setDirty(true);
  }, []);

  function addObject(type: LayoutObjectType) {
    pushHistory();
    // If a container is selected (and nesting stays within the depth cap), add the
    // new object INTO it; otherwise add at the top level.
    const intoId = selected && selected.config.type === "container" ? selected.id : null;
    const targetDepth = intoId ? depthOf(objects, intoId) + 1 : 0;
    const canNest =
      intoId != null && targetDepth <= MAX_DEPTH && !(type === "container" && targetDepth >= MAX_DEPTH);
    if (canNest && intoId) {
      const siblingMaxZ = (selected?.children ?? []).reduce((m, o) => Math.max(m, o.z), 0);
      // Default a new child to a centered box inside the container's local space.
      const geom = type === "container" ? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } : { x: 0.1, y: 0.3, w: 0.8, h: 0.4 };
      const child = makeObject(type, siblingMaxZ + 1, geom);
      setObjects((prev) => insertChild(prev, intoId, child));
      setSelectedId(child.id);
    } else {
      const o = makeObject(type, zTop + 1);
      // Snap a new top-level object onto the square grid so its edges land on lines.
      const sn = snapRectToGrid({ x: o.x, y: o.y, w: o.w, h: o.h }, CANVAS_FRAC, editorBox.w || canvas.width, editorBox.h || canvas.height, true);
      setObjects((prev) => [...prev, { ...o, ...sn }]);
      setSelectedId(o.id);
    }
  }
  /** Snap the selected object's existing position + size onto the grid. */
  function snapObjectToGrid(id: string) {
    const o = findById(objects, id);
    if (!o) return;
    const depth = depthOf(objects, id);
    let pAbs: FracRect = CANVAS_FRAC;
    if (depth > 0) {
      const p = getParentOf(objects, id);
      if (p) forEachWithRect(objects, (n) => { if (n.o.id === p.id) pAbs = n.abs; });
    }
    const sn = snapRectToGrid({ x: o.x, y: o.y, w: o.w, h: o.h }, pAbs, editorBox.w || canvas.width, editorBox.h || canvas.height, true);
    pushHistory();
    update(id, sn);
  }
  function removeObject(id: string) {
    if (isLockedInTree(objects, id)) return; // locked → must unlock before deleting
    pushHistory();
    setObjects((prev) => removeById(prev, id).tree);
    if (selectedId === id) setSelectedId(null);
  }
  function duplicateObject(id: string) {
    const src = findById(objects, id);
    if (!src) return;
    pushHistory();
    const siblings = getSiblings(objects, id);
    const z = siblings.reduce((m, o) => Math.max(m, o.z), 0) + 1;
    const copy: LayoutObject = {
      ...deepCloneFreshIds(src, uid),
      x: clamp(src.x + 0.03, 0, 1 - src.w),
      y: clamp(src.y + 0.03, 0, 1 - src.h),
      z,
    };
    const parent = getParentOf(objects, id);
    setObjects((prev) => (parent ? insertChild(prev, parent.id, copy) : [...prev, copy]));
    setSelectedId(copy.id);
  }
  // Move a nested object out to the top level, keeping its on-screen position by
  // converting its parent-local rect to an absolute canvas rect.
  function reparentToRoot(id: string) {
    let abs: FracRect | null = null;
    forEachWithRect(objects, (n) => { if (n.o.id === id) abs = n.abs; });
    if (!abs) return;
    const placed: FracRect = abs;
    pushHistory();
    setObjects((prev) => {
      const { tree, removed } = removeById(prev, id);
      if (!removed) return prev;
      const z = tree.reduce((m, o) => Math.max(m, o.z), 0) + 1;
      return [...tree, { ...removed, x: placed.x, y: placed.y, w: placed.w, h: placed.h, z }];
    });
  }
  // Drop a top-level object into a container, converting its absolute canvas rect
  // to a parent-local rect so it stays put. Stable identity (no deps) so the
  // canvas drag effect doesn't re-subscribe its window listeners mid-drag. The
  // move gesture already pushed history at drag start, so this doesn't push again.
  const reparentIntoContainer = useCallback((id: string, containerId: string, objAbs: FracRect, contAbs: FracRect) => {
    setObjects((prev) => {
      const { tree, removed } = removeById(prev, id);
      if (!removed) return prev;
      const local = localizeRect(contAbs, objAbs);
      const w = Math.min(local.w, 1);
      const h = Math.min(local.h, 1);
      const cont = findById(tree, containerId);
      const z = (cont?.children ?? []).reduce((m, o) => Math.max(m, o.z), 0) + 1;
      return insertChild(tree, containerId, { ...removed, x: clamp(local.x, 0, 1 - w), y: clamp(local.y, 0, 1 - h), w, h, z });
    });
    setDirty(true);
    setSelectedId(id);
  }, []);
  function reorder(id: string, dir: "front" | "back" | "up" | "down") {
    pushHistory();
    const reorderScope = (list: LayoutObject[]): LayoutObject[] => {
      const sorted = [...list].sort((a, b) => a.z - b.z);
      const idx = sorted.findIndex((o) => o.id === id);
      if (idx === -1) return list;
      if (dir === "front") sorted.push(sorted.splice(idx, 1)[0]);
      else if (dir === "back") sorted.unshift(sorted.splice(idx, 1)[0]);
      else if (dir === "up" && idx < sorted.length - 1) [sorted[idx], sorted[idx + 1]] = [sorted[idx + 1], sorted[idx]];
      else if (dir === "down" && idx > 0) [sorted[idx], sorted[idx - 1]] = [sorted[idx - 1], sorted[idx]];
      return sorted.map((o, i) => ({ ...o, z: i + 1 }));
    };
    setObjects((prev) => {
      const parent = getParentOf(prev, id);
      return parent
        ? mapById(prev, parent.id, (p) => ({ ...p, children: reorderScope(p.children ?? []) }))
        : reorderScope(prev);
    });
  }
  function undo() {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setObjects(prev);
      setDirty(true);
      return h.slice(0, -1);
    });
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({ version: 1, canvas, objects });
      setDirty(false);
      setHistory([]);
    } finally {
      setSaving(false);
    }
  }

  // commit-before-edit wrapper for inspector edits
  function withHistory<T extends unknown[]>(fn: (...a: T) => void) {
    return (...a: T) => { pushHistory(); fn(...a); };
  }

  const layerRows = flattenLayers(objects);

  return (
    <div className="flex flex-col gap-3 @container h-full min-h-0">
      {/* View-only bar — a custom view opens as a clean preview until "Edit". */}
      {!isEditing && (
        <div className="flex items-center gap-2">
          <div className="flex-1" />
          <Button variant="accent" size="small" onClick={() => setIsEditing(true)}>
            <PencilIcon className="size-3.5" /> Edit layout
          </Button>
        </div>
      )}

      {/* Toolbar (edit mode) */}
      {isEditing && (
      <div className="flex flex-wrap items-center gap-2">
        <Select value="" onValueChange={(t: string) => addObject(t as LayoutObjectType)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="+ Add object" /></SelectTrigger>
          <SelectContent>
            {PALETTE.map((t) => (
              <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant={gridOn ? "accent" : "filled"} size="small" onClick={() => setGridOn((v) => !v)} aria-label="Toggle snap grid">
          <Grid3x3Icon className="size-3.5" /> Grid
        </Button>
        <Button variant="filled" size="small" onClick={snapAllToGrid} aria-label="Snap all objects to grid" title="Snap every object's position + size to the grid">
          Snap all
        </Button>
        <Select
          value={CANVAS_PRESETS.find((p) => p.w === canvas.width && p.h === canvas.height)?.id ?? "custom"}
          onValueChange={(id: string) => {
            const p = CANVAS_PRESETS.find((x) => x.id === id);
            if (p) { setCanvas({ ...canvas, width: p.w, height: p.h }); setDirty(true); }
          }}
        >
          <SelectTrigger className="w-40" aria-label="Canvas shape"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CANVAS_PRESETS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
            {!CANVAS_PRESETS.some((p) => p.w === canvas.width && p.h === canvas.height) && (
              <SelectItem value="custom" disabled>Custom · {canvas.width}×{canvas.height}</SelectItem>
            )}
          </SelectContent>
        </Select>
        {/* Custom canvas size */}
        <div className="flex items-center gap-1" title="Custom canvas size (design width × height)">
          <NumberField value={canvas.width} step={10} min={100} onChange={(w) => { if (w >= 100) { setCanvas({ ...canvas, width: Math.round(w) }); setDirty(true); } }} />
          <span className="text-caption2 text-gray-9">×</span>
          <NumberField value={canvas.height} step={10} min={100} onChange={(h) => { if (h >= 100) { setCanvas({ ...canvas, height: Math.round(h) }); setDirty(true); } }} />
        </div>
        {/* Fit: letterbox the design aspect, or fill the whole window. */}
        <ButtonGroup>
          <Button variant={canvas.fit !== "fill" ? "accent" : "filled"} size="small" onClick={() => { setCanvas({ ...canvas, fit: "contain" }); setDirty(true); }} title="Letterbox: keep the design aspect (adds bars on mismatched screens)">Letterbox</Button>
          <Button variant={canvas.fit === "fill" ? "accent" : "filled"} size="small" onClick={() => { setCanvas({ ...canvas, fit: "fill" }); setDirty(true); }} title="Fill: use the whole window; objects reflow to its shape (no bars)">Fill</Button>
        </ButtonGroup>
        <Button variant="filled" size="small" onClick={undo} disabled={history.length === 0}>
          <UndoIcon className="size-3.5" /> Undo
        </Button>
        <Button variant="filled" size="small" onClick={startFromDashboard} title="Replace the layout with the dashboard design as editable tiles">
          <LayoutTemplateIcon className="size-3.5" /> Start from Dashboard
        </Button>

        {templates.length > 0 && (
          <Select
            value=""
            onValueChange={(id: string) => { const t = templates.find((x) => x.id === id); if (t) loadTemplate(t); }}
          >
            <SelectTrigger className="w-40"><SelectValue placeholder="Load layout…" /></SelectTrigger>
            <SelectContent>
              {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Dialog
          trigger={<Button variant="filled" size="small"><SaveIcon className="size-3.5" /> Save as layout</Button>}
          title="Save layout to library"
          description="Save this design by name so you can reuse it on other custom displays."
          confirmLabel="Save"
          confirmDisabled={tplName.trim().length === 0}
          onConfirm={async () => { await onSaveTemplate(tplName.trim(), currentLayout()); setTplName(""); }}
        >
          <Input
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            placeholder="Layout name (e.g. Lyrics + Timer)"
            className="text-gray-12"
            autoFocus
          />
        </Dialog>

        <div className="flex-1" />
        {dirty && (
          <Button variant="accent" size="small" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save layout"}
          </Button>
        )}
        <Button variant="filled" size="small" onClick={leaveEditMode}>
          <CheckIcon className="size-3.5" /> Done
        </Button>
      </div>
      )}

      <div className="flex gap-3 @max-4xl:flex-col min-h-0">
        {/* Canvas — height derived from its width + the design aspect (capped at
            the viewport), so it has a definite size, never jumps, and the inline
            slots editor sits right below it. */}
        <div ref={canvasCellRef} className="flex-1 min-w-0 @max-4xl:flex-none" style={{ height: canvasH ?? undefined }}>
          {data.state ? (
            <EditorCanvas
              canvas={canvas}
              objects={objects}
              selectedId={selectedId}
              gridOn={gridOn && isEditing}
              interactive={isEditing}
              ctx={{ ...data, state: data.state }}
              ndiSource={view.ndiSource ?? null}
              onSelect={setSelectedId}
              onGeom={onGeom}
              onCommitStart={pushHistory}
              onReparent={reparentIntoContainer}
              onBoxSize={handleBoxSize}
            />
          ) : (
            <div className="w-full h-full rounded-xl border border-gray-a4 flex items-center justify-center text-gray-7">
              Loading…
            </div>
          )}
        </div>

        {/* Side panel: layers + inspector (edit mode only). Capped to the canvas
            height so it scrolls beside the preview instead of stretching the row. */}
        {isEditing && (
        <div className="w-64 shrink-0 flex flex-col gap-3 min-h-0 overflow-y-auto @max-4xl:w-full" style={{ maxHeight: canvasH ?? undefined }}>
          {/* Layers */}
          <div className="flex flex-col gap-1">
            <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Layers</span>
            {layerRows.length === 0 && <span className="text-caption2 text-gray-7">No objects yet — add one above.</span>}
            {layerRows.map(({ o, depth }) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setSelectedId(o.id)}
                style={{ paddingLeft: 8 + depth * 14 }}
                className={`flex items-center gap-1.5 rounded-md pr-2 py-1 text-left ${o.id === selectedId ? "bg-gray-a4" : "hover:bg-gray-a3"}`}
              >
                <span className="text-caption1 text-gray-12 flex-1 min-w-0 truncate">
                  {o.config.type === "container" ? `${TYPE_LABELS[o.config.type]} (${o.children?.length ?? 0})` : TYPE_LABELS[o.config.type]}
                </span>
                {depth > 0 && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); reparentToRoot(o.id); }}
                    className="text-gray-9 hover:text-gray-12"
                    aria-label="Move out of container"
                    title="Move out of container"
                  >
                    <CornerLeftUpIcon className="size-3.5" />
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); pushHistory(); update(o.id, { locked: !o.locked }); }}
                  className={o.locked ? "text-amber-10" : "text-gray-9 hover:text-gray-12"}
                  aria-label={o.locked ? "Unlock" : "Lock"}
                >
                  {o.locked ? <LockIcon className="size-3.5" /> : <UnlockIcon className="size-3.5" />}
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); pushHistory(); update(o.id, { hidden: !o.hidden }); }}
                  className="text-gray-9 hover:text-gray-12"
                  aria-label={o.hidden ? "Show" : "Hide"}
                >
                  {o.hidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </span>
              </button>
            ))}
          </div>

          {selected && (
            <>
              <Separator />
              <Inspector
                key={selected.id}
                o={selected}
                canvas={canvas}
                parentW={selParentAbs.w * canvas.width}
                parentH={selParentAbs.h * canvas.height}
                nested={selDepth > 0}
                locked={isLockedInTree(objects, selected.id)}
                slotsViews={slotsViews}
                onGeom={(g) => { /* numeric position edits */ pushHistory(); update(selected.id, g); }}
                onStyle={withHistory((patch: Partial<LayoutStyle>) => updateStyle(selected.id, patch))}
                onConfig={withHistory((config: LayoutObjectConfig) => updateConfig(selected.id, config))}
                onReorder={(d) => reorder(selected.id, d)}
                onDuplicate={() => duplicateObject(selected.id)}
                onRemove={() => removeObject(selected.id)}
                onReparentOut={() => reparentToRoot(selected.id)}
                onToggleLock={() => { pushHistory(); update(selected.id, { locked: !selected.locked }); }}
                onSaveGroup={() => { setGroupName(""); setGroupDlgOpen(true); }}
                onSnapToGrid={() => snapObjectToGrid(selected.id)}
              />
            </>
          )}

          {/* Saved layout library */}
          {templates.length > 0 && (
            <>
              <Separator />
              <div className="flex flex-col gap-1">
                <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Saved layouts</span>
                {templates.map((t) => (
                  <div key={t.id} className="flex items-center gap-0.5 rounded-md px-2 py-1 hover:bg-gray-a3">
                    <span className="text-caption1 text-gray-12 flex-1 min-w-0 truncate">{t.name}</span>
                    <Button variant="transparent" size="small" iconOnly onClick={() => loadTemplate(t)} aria-label="Load into editor" title="Load into editor">
                      <DownloadIcon className="size-3.5 text-gray-9" />
                    </Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => onUpdateTemplate(t.id, { layout: currentLayout() })} aria-label="Overwrite with current" title="Overwrite with current layout">
                      <SaveIcon className="size-3.5 text-gray-9" />
                    </Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => onDeleteTemplate(t.id)} aria-label="Delete layout">
                      <Trash2Icon className="size-3.5 text-red-10" />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Saved groups library (reusable containers) */}
          <Separator />
          <div className="flex flex-col gap-1">
            <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Saved groups</span>
            {groups.length === 0 ? (
              <span className="text-caption2 text-gray-9">Select a container and use the package icon in the inspector to save it as a reusable group.</span>
            ) : (
              groups.map((g) => (
                <div key={g.id} className="flex items-center gap-0.5 rounded-md px-2 py-1 hover:bg-gray-a3">
                  <span className="text-caption1 text-gray-12 flex-1 min-w-0 truncate">{g.name}</span>
                  <Button variant="transparent" size="small" iconOnly onClick={() => insertGroup(g)} aria-label="Insert group" title="Insert into this view">
                    <DownloadIcon className="size-3.5 text-gray-9" />
                  </Button>
                  <Button variant="transparent" size="small" iconOnly onClick={() => deleteGroup(g.id)} aria-label="Delete group">
                    <Trash2Icon className="size-3.5 text-red-10" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
        )}
      </div>

      {/* Inline mic-slots editor — full width below the canvas when an inline
          slots-grid object is selected (scroll down to reach it). */}
      {isEditing && inlineGrid && (
        <div className="pb-[40vh]">
          <Separator />
          <div className="pt-3">
            <InlineSlotsEditor
              key={inlineGrid.id}
              objectId={inlineGrid.id}
              slotsLayout={inlineGrid.config.slotsLayout ?? null}
              onSetLayout={(next) => { pushHistory(); updateConfig(inlineGrid.id, { ...inlineGrid.config, slotsLayout: next }); }}
            />
          </div>
        </div>
      )}

      {/* Leaving edit mode with unsaved changes. */}
      <DialogPrimitive.Root open={confirmLeave} onOpenChange={setConfirmLeave}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              This layout has unsaved changes. Save them before leaving edit mode?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="transparent"
              size="small"
              onClick={() => { discardChanges(); setConfirmLeave(false); setIsEditing(false); }}
            >
              Discard
            </Button>
            <Button
              variant="accent"
              size="small"
              disabled={saving}
              onClick={async () => { await save(); setConfirmLeave(false); setIsEditing(false); }}
            >
              {saving ? "Saving…" : "Save & close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPrimitive.Root>

      {/* Save the selected container as a reusable group. */}
      <DialogPrimitive.Root open={groupDlgOpen} onOpenChange={setGroupDlgOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save as group</DialogTitle>
            <DialogDescription>
              Save this container and its objects as a reusable group you can insert into other custom views.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name (e.g. Vocal notes panel)"
            className="text-gray-12"
            autoFocus
          />
          <DialogFooter>
            <Button variant="transparent" size="small" onClick={() => setGroupDlgOpen(false)}>Cancel</Button>
            <Button variant="accent" size="small" disabled={groupName.trim().length === 0} onClick={saveSelectedAsGroup}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </DialogPrimitive.Root>
    </div>
  );
}

// ── inspector ────────────────────────────────────────────────────────────────

const WEIGHTS = [300, 400, 500, 600, 700, 800];

/**
 * Binding + framing controls for a plan-attachment object: a filename match (so it
 * tracks the stage plot week to week), a picker of the current plan's files, the
 * PDF page, plus crop / trim / background recolor of the rendered image and a
 * "fit box to file" action. All framing acts on the rendered image, not the source
 * file in Planning Center.
 */
function PlanAttachmentConfig({
  c,
  onConfig,
  o,
  canvas,
  onGeom,
}: {
  c: Extract<LayoutObjectConfig, { type: "plan-attachment" }>;
  onConfig: (config: LayoutObjectConfig) => void;
  o: LayoutObject;
  canvas: LayoutCanvas;
  onGeom: (g: Partial<Pick<LayoutObject, "x" | "y" | "w" | "h">>) => void;
}) {
  const [files, setFiles] = useState<PcoAttachmentDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fitting, setFitting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/pco/attachments")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: PcoAttachmentDTO[]) => {
        if (!cancelled) {
          setFiles(Array.isArray(list) ? list : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide audio stems / raw media — a stage plot is a document (PDF/image).
  const pickable = files.filter((f) => {
    const ct = (f.contentType ?? "").toLowerCase();
    return !ct.startsWith("audio") && ct !== "application/octet-stream";
  });

  const crop = c.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const setCrop = (side: "top" | "right" | "bottom" | "left", pct: number) =>
    onConfig({ ...c, crop: { ...crop, [side]: Math.max(0, Math.min(95, pct)) / 100 } });

  // Resize the object box to match the rendered (cropped/trimmed) content aspect,
  // keeping the top-left anchor so there's no letterboxing.
  async function fitBoxToFile() {
    setFitting(true);
    try {
      const r = await loadProcessedAttachment(c.match ?? "stage plot", {
        page: c.page ?? 1,
        crop: c.crop,
        trim: c.trim,
        background: c.background,
      });
      if (r && r !== "empty" && r.height > 0) {
        const aspect = r.width / r.height; // w:h of the image in px
        const newH = (o.w * canvas.width) / aspect / canvas.height;
        onGeom({ h: Math.max(0.03, Math.min(1 - o.y, newH)) });
      }
    } finally {
      setFitting(false);
    }
  }

  return (
    <>
      <Row label="Match">
        <Input
          value={c.match ?? "stage plot"}
          onChange={(e) => onConfig({ ...c, match: e.target.value })}
          placeholder="filename contains…"
          className="text-gray-12"
        />
      </Row>
      {pickable.length > 0 && (
        <Row label="Current plan">
          <Select value="" onValueChange={(v: string) => onConfig({ ...c, match: v })}>
            <SelectTrigger><SelectValue placeholder="Pick a file…" /></SelectTrigger>
            <SelectContent>
              {pickable.map((f) => (
                <SelectItem key={f.id} value={f.filename}>
                  {f.filename}{f.sourceLabel ? ` — ${f.sourceLabel}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
      {loaded && pickable.length === 0 && (
        <p className="text-caption2 text-gray-9 leading-snug">
          No documents on the current plan (or PCO isn’t connected). The match still
          applies whenever a plan with a matching file goes live.
        </p>
      )}
      <Row label="PDF page">
        <NumberInput value={c.page ?? 1} step={1} min={1} max={99} onChange={(v) => onConfig({ ...c, page: Math.round(v) })} />
      </Row>

      <Separator />

      <Row label="Trim white">
        <Switch checked={c.trim ?? false} onCheckedChange={(v) => onConfig({ ...c, trim: v })} />
      </Row>
      <Row label="Background">
        <ButtonGroup>
          <Button variant={(c.background ?? "keep") === "keep" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, background: "keep" })}>Keep</Button>
          <Button variant={c.background === "black" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, background: "black" })}>Black</Button>
          <Button variant={c.background === "transparent" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, background: "transparent" })}>Clear</Button>
        </ButtonGroup>
      </Row>
      <Row label="Crop %">
        <div className="grid grid-cols-2 gap-1 flex-1">
          <NumberInput value={Math.round((crop.top ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("top", v)} />
          <NumberInput value={Math.round((crop.bottom ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("bottom", v)} />
          <NumberInput value={Math.round((crop.left ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("left", v)} />
          <NumberInput value={Math.round((crop.right ?? 0) * 100)} step={1} min={0} max={95} onChange={(v) => setCrop("right", v)} />
        </div>
      </Row>
      <p className="text-caption2 text-gray-9 -mt-1">Top · Bottom · Left · Right</p>
      <Button variant="filled" size="small" onClick={fitBoxToFile} disabled={fitting}>
        {fitting ? "Fitting…" : "Fit box to file"}
      </Button>
    </>
  );
}

function Inspector({
  o, canvas, parentW, parentH, nested, locked, slotsViews, onGeom, onStyle, onConfig, onReorder, onDuplicate, onRemove, onReparentOut, onToggleLock, onSaveGroup, onSnapToGrid,
}: {
  o: LayoutObject;
  canvas: LayoutCanvas;
  /** Design-px size of this object's parent box (the canvas for top-level). */
  parentW: number;
  parentH: number;
  /** True when this object lives inside a container. */
  nested: boolean;
  /** True when this object — or an ancestor container — is locked. */
  locked: boolean;
  slotsViews: View[];
  onGeom: (g: Partial<Pick<LayoutObject, "x" | "y" | "w" | "h">>) => void;
  onStyle: (patch: Partial<LayoutStyle>) => void;
  onConfig: (config: LayoutObjectConfig) => void;
  onReorder: (d: "front" | "back" | "up" | "down") => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onReparentOut: () => void;
  onToggleLock: () => void;
  /** Save this object (typically a container) to the reusable group library. */
  onSaveGroup: () => void;
  /** Snap this object's existing position + size onto the grid. */
  onSnapToGrid: () => void;
}) {
  const s = o.style ?? {};
  const c = o.config;
  const chargerBays = useStageState().state?.chargerBays ?? [];
  const spl = useSplState();
  const obs = useObsState();
  const peopleCount = usePeopleCountState();
  const oscTargets = useOscTargets();
  const planItems = usePlanItems();
  const isText = !["shape", "container", "ndi-video", "slide-thumbnail", "image", "plan-attachment", "brand-logo", "slots-grid"].includes(c.type);
  // Style sizes are stored as fractions of canvas HEIGHT; show them as px (rounded
  // to 1 decimal so they read as whole numbers but still allow fine values).
  const pxOf = (frac: number | undefined, dflt: number) => Math.round((frac ?? dflt) * canvas.height * 10) / 10;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1">
        <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9 flex-1">{TYPE_LABELS[c.type]}</span>
        {c.type === "container" && (
          <Button variant="transparent" size="small" iconOnly onClick={onSaveGroup} aria-label="Save as group"><PackagePlusIcon className="size-3.5 text-gray-9" /></Button>
        )}
        <Button variant="transparent" size="small" iconOnly disabled={locked} onClick={onSnapToGrid} aria-label="Snap to grid" title="Snap position + size to the grid"><Grid3x3Icon className="size-3.5 text-gray-9" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onToggleLock} aria-label={o.locked ? "Unlock" : "Lock"}>
          {o.locked ? <LockIcon className="size-3.5 text-amber-10" /> : <UnlockIcon className="size-3.5 text-gray-9" />}
        </Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("up")} aria-label="Bring forward"><ChevronUpIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("down")} aria-label="Send backward"><ChevronDownIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onDuplicate} aria-label="Duplicate"><CopyIcon className="size-3.5 text-gray-9" /></Button>
        <Button variant="transparent" size="small" iconOnly disabled={locked} onClick={onRemove} aria-label="Delete"><Trash2Icon className={`size-3.5 ${locked ? "text-gray-7" : "text-red-10"}`} /></Button>
      </div>

      {nested && (
        <Button variant="filled" size="small" onClick={onReparentOut}>
          <CornerLeftUpIcon className="size-3.5" /> Move out of container
        </Button>
      )}

      {/* Binding */}
      {c.type === "text" && (
        <Row label="Text"><Input value={c.text} onChange={(e) => onConfig({ type: "text", text: e.target.value })} className="text-gray-12" /></Row>
      )}
      {c.type === "clock" && (
        <>
          <Row label="Format">
            <ButtonGroup>
              <Button variant={c.format !== "24h" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, format: "12h" })}>12h</Button>
              <Button variant={c.format === "24h" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, format: "24h" })}>24h</Button>
            </ButtonGroup>
          </Row>
          <Row label="Seconds"><Switch checked={c.showSeconds ?? true} onCheckedChange={(v) => onConfig({ ...c, showSeconds: v })} /></Row>
          {c.format !== "24h" && (
            <Row label="AM / PM"><Switch checked={c.showMeridiem ?? true} onCheckedChange={(v) => onConfig({ ...c, showMeridiem: v })} /></Row>
          )}
        </>
      )}
      {c.type === "section-chip" && (
        <Row label="Which">
          <Select value={c.which} onValueChange={(v: string) => onConfig({ type: "section-chip", which: v as "current" | "next" | "nextArrangement" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="current">Current</SelectItem>
              <SelectItem value="next">Next</SelectItem>
              <SelectItem value="nextArrangement">Next section</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      )}
      {c.type === "service-order" && (
        <>
          <Row label="Scroll">
            <ButtonGroup>
              <Button variant={(c.scroll ?? "auto") === "auto" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, scroll: "auto" })}>Follow live</Button>
              <Button variant={c.scroll === "static" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, scroll: "static" })}>Static</Button>
            </ButtonGroup>
          </Row>
          <Row label="Fit to height"><Switch checked={c.autoFit ?? true} onCheckedChange={(v) => onConfig({ ...c, autoFit: v })} /></Row>
          <Row label="Highlight live"><Switch checked={c.highlightLive ?? true} onCheckedChange={(v) => onConfig({ ...c, highlightLive: v })} /></Row>
          <Row label="Show length"><Switch checked={c.showLength ?? false} onCheckedChange={(v) => onConfig({ ...c, showLength: v })} /></Row>
          {(() => {
            const present = planItems?.noteCategories ?? [];
            if (present.length === 0) {
              return <span className="text-caption2 text-gray-9">Note categories appear once a plan with notes is loaded.</span>;
            }
            // null/undefined = all shown; otherwise the explicit subset.
            const shown = c.noteCategories == null ? present : present.filter((k) => c.noteCategories!.includes(k));
            const toggle = (k: string) => {
              const next = shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k];
              onConfig({ ...c, noteCategories: next });
            };
            return (
              <div className="flex flex-col gap-1">
                <span className="text-caption2 text-gray-9">Notes shown</span>
                <div className="flex flex-wrap gap-1.5">
                  {present.map((k) => {
                    const on = shown.includes(k);
                    return (
                      <button
                        key={k}
                        onClick={() => toggle(k)}
                        className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${on ? "border-blue-7 bg-blue-3 text-blue-11" : "border-gray-5 bg-gray-2 text-gray-10 hover:bg-gray-3"}`}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>
      )}
      {c.type === "transcript-strip" && (
        <>
          <Row label="Mode">
            <ButtonGroup>
              <Button variant={c.mode === "latest" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, mode: "latest" })}>Latest</Button>
              <Button variant={c.mode === "rolling" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, mode: "rolling" })}>Rolling</Button>
            </ButtonGroup>
          </Row>
          {c.mode === "rolling" && (
            <Row label="Lines"><NumberInput value={c.maxLines ?? 3} step={1} min={1} max={10} onChange={(v) => onConfig({ ...c, maxLines: Math.round(v) })} /></Row>
          )}
        </>
      )}
      {c.type === "slots-grid" && (() => {
        const isInline = (c.source ?? "view") === "inline";
        return (
          <>
            <Row label="Source">
              <Select value={isInline ? "inline" : "view"} onValueChange={(v: string) => onConfig({ ...c, source: v === "inline" ? "inline" : "view" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inline">Define here</SelectItem>
                  <SelectItem value="view">Embed a view</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {isInline ? (
              <p className="text-caption2 text-gray-9 leading-snug">Edit this grid's slots below the canvas.</p>
            ) : (
              <Row label="View">
                <Select value={c.sourceViewId ?? ""} onValueChange={(v: string) => onConfig({ ...c, source: "view", sourceViewId: v || null })}>
                  <SelectTrigger><SelectValue placeholder="Mic-slots view…" /></SelectTrigger>
                  <SelectContent>
                    {slotsViews.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>
            )}
          </>
        );
      })()}
      {c.type === "charger-battery" && (
        <>
          <Row label="Battery %"><Switch checked={c.show.battery ?? false} onCheckedChange={(v) => onConfig({ ...c, show: { ...c.show, battery: v } })} /></Row>
          <Row label="Charging"><Switch checked={c.show.charging ?? false} onCheckedChange={(v) => onConfig({ ...c, show: { ...c.show, charging: v } })} /></Row>
          <Row label="Cycles"><Switch checked={c.show.cycles ?? false} onCheckedChange={(v) => onConfig({ ...c, show: { ...c.show, cycles: v } })} /></Row>
          <Row label="Health"><Switch checked={c.show.health ?? false} onCheckedChange={(v) => onConfig({ ...c, show: { ...c.show, health: v } })} /></Row>
          <Row label="Temp"><Switch checked={c.show.temp ?? false} onCheckedChange={(v) => onConfig({ ...c, show: { ...c.show, temp: v } })} /></Row>
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Bays</span>
            {c.bays.map((b, i) => {
              const bay = chargerBays.find((x) => x.id === b.id);
              const placeholder = bay ? `${bay.connectionName ?? `Charger ${bay.chargerIndex}`} · Bay ${bay.bay}` : "Bay";
              return (
                <div key={b.id} className="flex items-center gap-1.5">
                  <Input
                    value={b.label ?? ""}
                    placeholder={placeholder}
                    onChange={(e) => {
                      const label = e.target.value;
                      onConfig({ ...c, bays: c.bays.map((x, j) => (j === i ? { ...x, label: label || undefined } : x)) });
                    }}
                    className="text-gray-12 flex-1"
                  />
                  <Button variant="transparent" size="small" iconOnly onClick={() => onConfig({ ...c, bays: c.bays.filter((_, j) => j !== i) })} aria-label="Remove bay"><Trash2Icon className="size-3.5 text-red-10" /></Button>
                </div>
              );
            })}
            <Select value="" onValueChange={(id: string) => { if (id) onConfig({ ...c, bays: [...c.bays, { id }] }); }}>
              <SelectTrigger><SelectValue placeholder={chargerBays.length ? "Add bay…" : "No charger bays detected"} /></SelectTrigger>
              <SelectContent>
                {chargerBays.filter((bay) => !c.bays.some((b) => b.id === bay.id)).map((bay) => (
                  <SelectItem key={bay.id} value={bay.id}>{`${bay.connectionName ?? `Charger ${bay.chargerIndex}`} · Bay ${bay.bay}${bay.battery != null ? ` (${bay.battery}%)` : ""}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}
      {c.type === "spl-meter" && (() => {
        const meters = spl?.meters ?? {};
        const meterIds = Object.keys(meters);
        // Union of metric keys across all meters so the picker is usable even
        // before the selected channel has reported a reading.
        const metricKeys = Array.from(
          new Set(meterIds.flatMap((id) => Object.keys(meters[id].metrics))),
        );
        const t = c.thresholds;
        return (
          <>
            <Row label="Meter">
              <Select value={c.meterId ?? ""} onValueChange={(v: string) => onConfig({ ...c, meterId: v || null })}>
                <SelectTrigger><SelectValue placeholder={meterIds.length ? "Auto (first)" : "No meters detected"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Auto (first)</SelectItem>
                  {meterIds.map((id) => (
                    <SelectItem key={id} value={id}>{`${meters[id].deviceName} · ${meters[id].channelName}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Metric">
              <Select value={c.metricKey ?? ""} onValueChange={(v: string) => onConfig({ ...c, metricKey: v || null })}>
                <SelectTrigger><SelectValue placeholder={metricKeys.length ? "Auto" : "No data yet"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Auto</SelectItem>
                  {metricKeys.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Show metric name"><Switch checked={c.showLabel ?? false} onCheckedChange={(v) => onConfig({ ...c, showLabel: v })} /></Row>
            <Row label="Color thresholds">
              <Switch checked={!!t} onCheckedChange={(v) => onConfig({ ...c, thresholds: v ? { amber: 95, red: 100 } : null })} />
            </Row>
            {t && (
              <>
                <Row label="Amber ≥ (dB)"><NumberInput value={t.amber} step={1} min={0} max={140} onChange={(v) => onConfig({ ...c, thresholds: { ...t, amber: Math.round(v) } })} /></Row>
                <Row label="Red ≥ (dB)"><NumberInput value={t.red} step={1} min={0} max={140} onChange={(v) => onConfig({ ...c, thresholds: { ...t, red: Math.round(v) } })} /></Row>
              </>
            )}
          </>
        );
      })()}
      {c.type === "obs-status" && (
        <>
          <Row label="OBS">
            <span className="text-caption2 text-gray-10">
              {obs?.connected ? (obs.recording ? "Recording now" : "Connected · idle") : "Not connected"}
            </span>
          </Row>
          <Row label="Recording text"><Input value={c.recordingText ?? ""} onChange={(e) => onConfig({ ...c, recordingText: e.target.value })} placeholder="OBS: Recording" className="text-gray-12" /></Row>
          <Row label="Idle text"><Input value={c.idleText ?? ""} onChange={(e) => onConfig({ ...c, idleText: e.target.value })} placeholder="OBS: Standby" className="text-gray-12" /></Row>
          <Row label="Offline text"><Input value={c.offlineText ?? ""} onChange={(e) => onConfig({ ...c, offlineText: e.target.value })} placeholder="OBS: Offline" className="text-gray-12" /></Row>
          <Row label="Fill red when recording"><Switch checked={c.fillWhenRecording ?? true} onCheckedChange={(v) => onConfig({ ...c, fillWhenRecording: v })} /></Row>
          <Row label="Show timecode"><Switch checked={c.showTimecode ?? false} onCheckedChange={(v) => onConfig({ ...c, showTimecode: v })} /></Row>
          <Row label="Hide when idle"><Switch checked={c.hideWhenIdle ?? false} onCheckedChange={(v) => onConfig({ ...c, hideWhenIdle: v })} /></Row>
        </>
      )}
      {c.type === "osc-button" && (() => {
        const oc = c; // narrowed osc-button config (preserved into nested fns)
        const args = oc.args ?? [];
        const fb = oc.feedback ?? null;
        function setArg(i: number, patch: Partial<OscArg>) {
          const next = args.map((a, idx) => (idx === i ? { ...a, ...patch } : a));
          onConfig({ ...oc, args: next });
        }
        return (
          <>
            <Row label="Target">
              <Select value={c.targetId ?? ""} onValueChange={(v: string) => onConfig({ ...c, targetId: v || null })}>
                <SelectTrigger><SelectValue placeholder={oscTargets.length ? "Select target" : "No OSC targets"} /></SelectTrigger>
                <SelectContent>
                  {oscTargets.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Label"><Input value={c.label ?? ""} onChange={(e) => onConfig({ ...c, label: e.target.value })} placeholder="Button" className="text-gray-12" /></Row>
            <Row label="Address"><Input value={c.address} onChange={(e) => onConfig({ ...c, address: e.target.value })} placeholder="/ch/01/mix/on" className="text-gray-12" /></Row>
            <div className="flex flex-col gap-1.5">
              <span className="text-caption2 font-semibold uppercase tracking-wider text-gray-9">Arguments</span>
              {args.map((a, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Select value={a.type} onValueChange={(v: string) => setArg(i, { type: v as OscArg["type"] })}>
                    <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="i">int</SelectItem>
                      <SelectItem value="f">float</SelectItem>
                      <SelectItem value="s">string</SelectItem>
                      <SelectItem value="T">true</SelectItem>
                      <SelectItem value="F">false</SelectItem>
                    </SelectContent>
                  </Select>
                  {a.type !== "T" && a.type !== "F" && (
                    <Input value={String(a.value ?? "")} onChange={(e) => setArg(i, { value: e.target.value })} placeholder="value" className="flex-1 min-w-0 text-gray-12" />
                  )}
                  <Button variant="transparent" size="small" iconOnly onClick={() => onConfig({ ...c, args: args.filter((_, idx) => idx !== i) })} aria-label="Remove argument"><Trash2Icon className="size-3.5 text-gray-9" /></Button>
                </div>
              ))}
              <Button variant="transparent" size="small" className="self-start" onClick={() => onConfig({ ...c, args: [...args, { type: "i", value: "1" }] })}>Add argument</Button>
            </div>
            <Row label="Feedback">
              <Switch checked={!!fb} onCheckedChange={(v) => onConfig({ ...c, feedback: v ? { address: c.address || "/", equals: 1 } : null })} />
            </Row>
            {fb && (
              <>
                <Row label="Watch address"><Input value={fb.address} onChange={(e) => onConfig({ ...c, feedback: { ...fb, address: e.target.value } })} placeholder="/ch/01/mix/on" className="text-gray-12" /></Row>
                <Row label="Active when ="><Input value={String(fb.equals ?? "")} onChange={(e) => onConfig({ ...c, feedback: { ...fb, equals: e.target.value } })} placeholder="1 (blank = any truthy)" className="text-gray-12" /></Row>
                <Row label="Active color"><Input value={fb.activeColor ?? ""} onChange={(e) => onConfig({ ...c, feedback: { ...fb, activeColor: e.target.value } })} placeholder="var(--red-9)" className="text-gray-12" /></Row>
              </>
            )}
          </>
        );
      })()}
      {c.type === "people-counter" && (() => {
        const zones = peopleCount?.zones ?? [];
        return (
          <>
            <Row label="Count">
              <ButtonGroup>
                <Button variant={(c.metric ?? "attendance") === "attendance" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, metric: "attendance" })}>Attendance</Button>
                <Button variant={c.metric === "occupancy" ? "accent" : "filled"} size="small" onClick={() => onConfig({ ...c, metric: "occupancy" })}>In room</Button>
              </ButtonGroup>
            </Row>
            <Row label="Zone">
              <Select value={c.zoneId ?? ""} onValueChange={(v: string) => onConfig({ ...c, zoneId: v || null })}>
                <SelectTrigger><SelectValue placeholder={zones.length ? "Building total" : "No zones detected"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Building total</SelectItem>
                  {zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Show label"><Switch checked={c.showLabel ?? true} onCheckedChange={(v) => onConfig({ ...c, showLabel: v })} /></Row>
            {(c.showLabel ?? true) && (
              <Row label="Label"><Input value={c.label ?? ""} onChange={(e) => onConfig({ ...c, label: e.target.value })} placeholder={c.metric === "occupancy" ? "in room" : "people"} className="text-gray-12" /></Row>
            )}
          </>
        );
      })()}
      {c.type === "image" && (
        <Row label="URL"><Input value={c.src} onChange={(e) => onConfig({ type: "image", src: e.target.value })} placeholder="https://… or data:" className="text-gray-12" /></Row>
      )}
      {c.type === "plan-attachment" && (
        <PlanAttachmentConfig c={c} onConfig={onConfig} o={o} canvas={canvas} onGeom={onGeom} />
      )}
      {c.type === "shape" && (
        <Row label="Shape">
          <ButtonGroup>
            <Button variant={c.shape === "rect" ? "accent" : "filled"} size="small" onClick={() => onConfig({ type: "shape", shape: "rect" })}>Rect</Button>
            <Button variant={c.shape === "ellipse" ? "accent" : "filled"} size="small" onClick={() => onConfig({ type: "shape", shape: "ellipse" })}>Ellipse</Button>
          </ButtonGroup>
        </Row>
      )}
      {c.type === "brand-logo" && (
        <Row label="Empty logo"><Switch checked={c.useEmptySlotLogo ?? false} onCheckedChange={(v) => onConfig({ type: "brand-logo", useEmptySlotLogo: v })} /></Row>
      )}

      <Separator />

      {/* Card style presets — one-click dashboard "glass tile" look on any object,
          and "Flat" to clear it back. Just writes the shared style fields below. */}
      <Row label="Card">
        <div className="flex flex-wrap gap-1">
          {([["neutral", "Glass"], ["green", "Green"], ["red", "Red"], ["amber", "Amber"], ["flat", "Flat"]] as [CardAccent, string][]).map(([a, label]) => (
            <Button key={a} variant="filled" size="small" onClick={() => onStyle(CARD_PRESETS[a])}>{label}</Button>
          ))}
        </div>
      </Row>

      {/* Style */}
      {isText && (
        <>
          <Row label="Font size"><NumberField value={pxOf(s.fontSize, 0.05)} step={1} min={1} max={Math.round(0.5 * canvas.height)} suffix="px" onChange={(px) => onStyle({ fontSize: px / canvas.height })} /></Row>
          <Row label="Weight">
            <Select value={String(s.fontWeight ?? 400)} onValueChange={(v: string) => onStyle({ fontWeight: parseInt(v, 10) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{WEIGHTS.map((w) => <SelectItem key={w} value={String(w)}>{w}</SelectItem>)}</SelectContent>
            </Select>
          </Row>
          <Row label="Color"><input type="color" value={hexForInput(s.color, "#ffffff")} onChange={(e) => onStyle({ color: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-gray-a4 bg-transparent" /></Row>
          <Row label="Align">
            <ButtonGroup>
              {(["left", "center", "right"] as const).map((a) => (
                <Button key={a} variant={(s.textAlign ?? "center") === a ? "accent" : "filled"} size="small" onClick={() => onStyle({ textAlign: a })}>{a[0].toUpperCase()}</Button>
              ))}
            </ButtonGroup>
          </Row>
          <Row label="V-align">
            <ButtonGroup>
              {(["top", "middle", "bottom"] as const).map((a) => (
                <Button key={a} variant={(s.vAlign ?? "middle") === a ? "accent" : "filled"} size="small" onClick={() => onStyle({ vAlign: a })}>{a[0].toUpperCase()}</Button>
              ))}
            </ButtonGroup>
          </Row>
          <Row label="Uppercase"><Switch checked={s.uppercase ?? false} onCheckedChange={(v) => onStyle({ uppercase: v })} /></Row>
          <Row label="Shadow"><NumberInput value={s.textShadow ?? 0} step={0.1} min={0} max={1} onChange={(v) => onStyle({ textShadow: v })} /></Row>
          <Row label="Max lines"><NumberInput value={s.lineClamp ?? 0} step={1} min={0} max={10} onChange={(v) => onStyle({ lineClamp: v > 0 ? Math.round(v) : null })} /></Row>
        </>
      )}
      <Row label="Fill"><input type="color" value={hexForInput(s.background, "#000000")} onChange={(e) => onStyle({ background: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-gray-a4 bg-transparent" />
        <Button variant="transparent" size="small" onClick={() => onStyle({ background: null })}>Clear</Button>
      </Row>
      <Row label="Opacity">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round((s.opacity ?? 1) * 100)}
          onChange={(e) => onStyle({ opacity: parseInt(e.target.value, 10) / 100 })}
          className="flex-1 min-w-0 accent-blue-9"
          aria-label="Opacity"
        />
        <div className="w-16 shrink-0">
          <NumberField value={Math.round((s.opacity ?? 1) * 100)} step={1} min={0} max={100} suffix="%" onChange={(v) => onStyle({ opacity: clamp(v / 100, 0, 1) })} />
        </div>
      </Row>
      <Row label="Radius"><NumberField value={pxOf(s.cornerRadius, 0)} step={1} min={0} max={Math.round(0.5 * canvas.height)} suffix="px" onChange={(px) => onStyle({ cornerRadius: px / canvas.height })} /></Row>
      <Row label="Padding"><NumberField value={pxOf(s.padding, 0)} step={1} min={0} max={Math.round(0.3 * canvas.height)} suffix="px" onChange={(px) => onStyle({ padding: px / canvas.height })} /></Row>
      <Row label="Border">
        <input
          type="color"
          value={hexForInput(s.borderColor, "#ffffff")}
          onChange={(e) => onStyle({ borderColor: e.target.value, borderWidth: s.borderWidth ?? 0 })}
          className="w-9 h-7 rounded cursor-pointer border border-gray-a4 bg-transparent"
          aria-label="Border color"
        />
        <NumberField
          value={Math.round((s.borderWidth ?? 0) * canvas.height)}
          step={1}
          min={0}
          max={40}
          suffix="px"
          onChange={(px) => onStyle({ borderWidth: px / canvas.height, borderColor: s.borderColor ?? "#ffffff" })}
        />
      </Row>

      <Separator />

      {/* Align within the parent (canvas for top-level, container box if nested) */}
      <Row label="Align">
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 0 })} aria-label="Align left" title="Align left"><AlignStartVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: (1 - o.w) / 2 })} aria-label="Center horizontally" title="Center horizontally"><AlignCenterVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 1 - o.w })} aria-label="Align right" title="Align right"><AlignEndVertical className="size-3.5" /></Button>
        </ButtonGroup>
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 0 })} aria-label="Align top" title="Align top"><AlignStartHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: (1 - o.h) / 2 })} aria-label="Center vertically" title="Center vertically"><AlignCenterHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 1 - o.h })} aria-label="Align bottom" title="Align bottom"><AlignEndHorizontal className="size-3.5" /></Button>
        </ButtonGroup>
      </Row>

      {/* Position & size in design-px of the parent box (canvas for top-level) */}
      <span className="text-caption2 text-gray-9">
        Position &amp; size ({Math.round(parentW)}×{Math.round(parentH)}{nested ? " · in container" : ""})
      </span>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <PixelField label="X" value={o.x} dim={parentW} onChange={(v) => onGeom({ x: clamp(v, 0, 1 - o.w) })} />
        <PixelField label="Y" value={o.y} dim={parentH} onChange={(v) => onGeom({ y: clamp(v, 0, 1 - o.h) })} />
        <PixelField label="W" value={o.w} dim={parentW} onChange={(v) => onGeom({ w: clamp(v, MIN, 1 - o.x) })} />
        <PixelField label="H" value={o.h} dim={parentH} onChange={(v) => onGeom({ h: clamp(v, MIN, 1 - o.y) })} />
      </div>
    </div>
  );
}
