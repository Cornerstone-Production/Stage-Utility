import { useState, useEffect, useRef, useCallback, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import {
  UndoIcon,
  Trash2Icon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronsUpIcon,
  ChevronsDownIcon,
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
  FilterIcon,
  FilePlusIcon,
} from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Button,
  Input,
  NumberInput as UiNumberInput,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
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
  InfoHint,
  UnsavedBanner,
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
import {
  GRID,
  HANDLES,
  MIN,
  applyResize,
  clamp,
  gridUnits,
  handleCursor,
  hexForInput,
  snapRectToGrid,
  snapTo,
  type Handle,
} from "./layout-geometry.js";
import { useSplState } from "../../main/use-spl-state";
import { useWirelessChannels } from "../../main/use-wireless-channels";
import { usePeopleCountState } from "../../main/use-people-count-state";
import { useObsState } from "../../main/use-obs-state";
import { useReaperState } from "../../main/use-reaper-state";
import { useOscTargets } from "../../main/use-osc-state";
import { useStageState } from "../../main/use-stage-state";
import { usePlanItems } from "../../main/use-plan-items";
import { usePropInstances } from "../../main/use-dashboard-state";
import { useConfiguredIntegrations, useIntegrations } from "../../main/use-integration-states";
import {
  CARD_PRESETS,
  isKnownObjectType,
  isOfferableInEmbedPicker,
  objectRetired,
  PALETTE_GROUPS,
  defaultConfig,
  defaultStyle,
  isStylingOnly,
  objectIntegration,
  typeLabel,
  usesPropInstance,
} from "../../main/layout-objects";
import { invoke } from "../../lib/api";
import { InlineSlotsEditor } from "./inline-slots-editor";

// ── object metadata ──────────────────────────────────────────────────────────

const HIDE_UNCONFIGURED_KEY = "layout-hide-unconfigured";

// Deepest allowed object depth (top-level = 0). A container holding objects = 1;
// a container holding containers holding leaves = 2. Keeps the editor sane.
const MAX_DEPTH = 2;

// The canvas occupies the whole coordinate space; top-level objects are fractions of it.
const CANVAS_FRAC: FracRect = { x: 0, y: 0, w: 1, h: 1 };

// Dashboard "glass tile" look, expressed in the style fields every object shares.
// Border/radius/padding are fractions of canvas HEIGHT (≈1px / 16px on a 1080 canvas).
// Reused by the container default style and the Phase C preset buttons.
// Surface/elevation presets — a "style type" picker. Orthogonal to the color
// accents above: these set fill/border/elevation as a one-click "look" and leave
// the text color alone. They write the shared style fields, so the Fill / Border /
// Elevation controls still fine-tune afterward.
type SurfaceKind = "flat" | "glass" | "elevated" | "solid" | "outline";
const SURFACE_PRESETS: Record<SurfaceKind, LayoutStyle> = {
  flat: { background: null, borderColor: null, borderWidth: 0, boxShadow: 0 },
  glass: { background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 0.001, cornerRadius: 0.0148, boxShadow: 0 },
  elevated: { background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.10)", borderWidth: 0.001, cornerRadius: 0.0148, boxShadow: 0.6 },
  solid: { background: "var(--gray-2)", borderColor: null, borderWidth: 0, cornerRadius: 0.0148, boxShadow: 0.35 },
  outline: { background: null, borderColor: "rgba(255,255,255,0.35)", borderWidth: 0.0015, cornerRadius: 0.0148, boxShadow: 0 },
};

// One consolidated list of preset "looks" for the Style dropdown — each entry is a
// complete style patch (surface look, optionally color-tinted), so there's a single
// control instead of separate color + surface rows with duplicate labels.
const STYLE_PRESETS: { value: string; label: string; style: LayoutStyle }[] = [
  { value: "flat", label: "Flat", style: SURFACE_PRESETS.flat },
  { value: "glass", label: "Glass", style: SURFACE_PRESETS.glass },
  { value: "glass-green", label: "Glass · Green", style: CARD_PRESETS.green },
  { value: "glass-red", label: "Glass · Red", style: CARD_PRESETS.red },
  { value: "glass-amber", label: "Glass · Amber", style: CARD_PRESETS.amber },
  { value: "elevated", label: "Elevated", style: SURFACE_PRESETS.elevated },
  { value: "solid", label: "Solid", style: SURFACE_PRESETS.solid },
  { value: "outline", label: "Outline", style: SURFACE_PRESETS.outline },
];

// Which preset (if any) the current style matches — so the Style dropdown reflects
// the applied look and reads as "custom" (placeholder) once fields are hand-tweaked.
// A preset matches when every field IT sets equals the object's value.
function matchStylePreset(s: LayoutStyle): string {
  for (const p of STYLE_PRESETS) {
    const keys = Object.keys(p.style) as (keyof LayoutStyle)[];
    if (keys.every((k) => (s[k] ?? null) === (p.style[k] ?? null))) return p.value;
  }
  return "";
}

// Nearest labeled stop for the single Elevation slider (None/Low/Med/High).
function elevationLabel(v: number): string {
  if (v <= 0.175) return "None";
  if (v <= 0.5) return "Low";
  if (v <= 0.825) return "Med";
  return "High";
}

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
export function dashboardTemplate(): LayoutObject[] {
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
    tile(x2, y1, colW, rowH, "Service timer", body({ type: "countdown-timer" }, "#86efac", 0.09)),
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

// Build the built-in "Confidence Monitor" starter layout, reproducing the approved
// stage mockup: a top brand bar, a LEFT hero block titled CURRENT holding the current
// item + a huge on-pace-green countdown + a service-progress bar, and a RIGHT rail
// with a NEXT card over a 2×2 grid of readout tiles (Clock / SPL / Slides left /
// Attendance). All coords are canvas fractions (designed for 16:9). Fresh ids.
//
// Notes on object mapping: the "Slides left" tile uses `slide-progress`
// (ProPresenter slide position, "N left") — the closest supported readout to the
// mockup's "Slides left". The hero progress bar likewise uses `slide-progress`
// (display "bar"), which is driven by ProPresenter slide position, standing in for
// the mockup's abstract item-progress bar. The scripture reference + QR code in the
// mockup have no backing object type, so the reference is a plain text label and the
// QR is omitted.
export function confidenceMonitorTemplate(): LayoutObject[] {
  const GREEN = "#46c47e";
  const FG = "rgba(255,255,255,0.95)";
  const FG_MUTED = "rgba(255,255,255,0.56)";
  const FG_FAINT = "rgba(255,255,255,0.30)";
  const ACCENT = "#6aa6df";
  // Glass surface (near-black stage; cards read as faint frosted panels).
  const glass: LayoutStyle = { background: "rgba(255,255,255,0.035)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 0.001, cornerRadius: 0.014 };
  // Uppercase eyebrow/label used above hero + rail sections and on each tile.
  const eyebrow = (color = FG_FAINT): LayoutStyle => ({ fontSize: 0.017, fontWeight: 600, color, uppercase: true, letterSpacing: 0.14, textAlign: "left", vAlign: "middle" });

  let z = 0;
  const obj = (x: number, y: number, w: number, h: number, config: LayoutObjectConfig, style: LayoutStyle, children?: LayoutObject[]): LayoutObject => ({
    id: uid(), x, y, w, h, z: ++z, config, style, ...(children ? { children } : {}),
  });

  // ── top brand bar ──────────────────────────────────────────────────────────
  const bar = obj(0.02, 0.02, 0.96, 0.075, { type: "container" }, { ...glass, background: null, borderColor: null, borderWidth: 0 }, [
    { id: uid(), x: 0, y: 0.15, w: 0.06, h: 0.7, z: 1, config: { type: "brand-logo" }, style: { textAlign: "left", vAlign: "middle" } },
    { id: uid(), x: 0.07, y: 0, w: 0.4, h: 1, z: 2, config: { type: "text", text: "Stage Utility" }, style: { fontSize: 0.022, fontWeight: 600, color: FG, textAlign: "left", vAlign: "middle" } },
    { id: uid(), x: 0.35, y: 0, w: 0.4, h: 1, z: 3, config: { type: "text", text: "WEEKEND" }, style: { fontSize: 0.02, fontWeight: 500, color: FG_MUTED, letterSpacing: 0.04, textAlign: "center", vAlign: "middle" } },
    { id: uid(), x: 0.86, y: 0, w: 0.14, h: 1, z: 4, config: { type: "text", text: "LIVE" }, style: { fontSize: 0.02, fontWeight: 600, color: GREEN, uppercase: true, letterSpacing: 0.07, textAlign: "right", vAlign: "middle" } },
  ]);

  // ── LEFT: CURRENT hero (~60% width) ─────────────────────────────────────────
  const hero = obj(0.02, 0.115, 0.6, 0.87, { type: "container" }, {
    background: "rgba(70,196,126,0.06)", borderColor: "rgba(70,196,126,0.32)", borderWidth: 0.0012, cornerRadius: 0.018, padding: 0.02,
  }, [
    { id: uid(), x: 0.04, y: 0.06, w: 0.9, h: 0.06, z: 1, config: { type: "text", text: "Current" }, style: eyebrow() },
    { id: uid(), x: 0.04, y: 0.13, w: 0.92, h: 0.12, z: 2, config: { type: "current-service-item" }, style: { fontSize: 0.042, fontWeight: 500, color: FG, textAlign: "left", vAlign: "middle" } },
    // Huge Plex Mono countdown, on-pace green (Plex is inherited from the app).
    { id: uid(), x: 0.04, y: 0.3, w: 0.92, h: 0.42, z: 3, config: { type: "countdown-timer" }, style: { fontSize: 0.22, fontWeight: 500, color: GREEN, textAlign: "left", vAlign: "middle" } },
    { id: uid(), x: 0.04, y: 0.73, w: 0.9, h: 0.05, z: 4, config: { type: "text", text: "Remaining" }, style: eyebrow(FG_MUTED) },
    // Service-progress bar (color drives the fill).
    { id: uid(), x: 0.04, y: 0.83, w: 0.92, h: 0.06, z: 5, config: { type: "slide-progress", display: "bar", showLabel: false }, style: { color: GREEN, vAlign: "middle" } },
  ]);

  // ── RIGHT rail: NEXT card + 2×2 tiles ───────────────────────────────────────
  const railX = 0.64, railW = 0.34;
  const next = obj(railX, 0.115, railW, 0.2, { type: "container" }, { ...glass, padding: 0.014 }, [
    { id: uid(), x: 0.06, y: 0.12, w: 0.9, h: 0.22, z: 1, config: { type: "text", text: "Next" }, style: eyebrow() },
    { id: uid(), x: 0.06, y: 0.4, w: 0.9, h: 0.5, z: 2, config: { type: "next-service-item" }, style: { fontSize: 0.03, fontWeight: 500, color: FG, textAlign: "left", vAlign: "middle" } },
  ]);

  // 2×2 tile grid under the NEXT card.
  const tileTop = 0.335, gridBottom = 0.985, gap = 0.014;
  const tileW = (railW - gap) / 2;
  const rowH = (gridBottom - tileTop - gap) / 2;
  const cx1 = railX, cx2 = railX + tileW + gap;
  const ry1 = tileTop, ry2 = tileTop + rowH + gap;
  const tile = (x: number, y: number, label: string, content: LayoutObject): LayoutObject =>
    obj(x, y, tileW, rowH, { type: "container" }, { ...glass, padding: 0.012 }, [
      { id: uid(), x: 0.08, y: 0.14, w: 0.84, h: 0.24, z: 1, config: { type: "text", text: label }, style: eyebrow() },
      content,
    ]);
  const bigVal = (config: LayoutObjectConfig, color = FG): LayoutObject => ({
    id: uid(), x: 0.08, y: 0.42, w: 0.84, h: 0.5, z: 2, config, style: { fontSize: 0.058, fontWeight: 500, color, textAlign: "left", vAlign: "middle" },
  });
  const tiles = [
    tile(cx1, ry1, "Clock", bigVal({ type: "clock", showSeconds: false, format: "12h" })),
    tile(cx2, ry1, "SPL", bigVal({ type: "spl-meter", meterId: null, metricKey: null, showLabel: false, thresholds: null }, ACCENT)),
    tile(cx1, ry2, "Slides left", bigVal({ type: "slide-progress", display: "remaining", showLabel: false })),
    tile(cx2, ry2, "Attendance", bigVal({ type: "people-counter", metric: "attendance", zoneId: null, label: "Attendance", showLabel: false })),
  ];

  return [bar, hero, next, ...tiles];
}


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

/**
 * Reorder one sibling scope by dropping `id` above or below `targetId`.
 *
 * Works in the order the Layers panel SHOWS — z descending, topmost first — and
 * only converts back to z at the end. Reordering in z-ascending order and calling
 * it "insert before the target" is what made the top of the list unreachable:
 * there is no row above the first one to drop before, so the only way to promote
 * something to the top was to drop it under the current top and then drag that
 * one down past it. An explicit edge has a slot at both ends by construction.
 *
 * z is reassigned across the whole scope so it stays a dense 1..n with no ties —
 * a tie makes paint order depend on array order, which is exactly the kind of
 * "it moved on its own" that is impossible to reproduce later.
 *
 * Exported for the guard; the index arithmetic is the part worth pinning.
 */
export function reorderLayerScope(
  list: LayoutObject[],
  id: string,
  targetId: string,
  edge: "above" | "below",
): LayoutObject[] {
  // Display order: topmost (highest z) first, matching flattenLayers.
  const display = [...list].sort((a, b) => b.z - a.z);
  const from = display.findIndex((o) => o.id === id);
  if (from === -1 || !display.some((o) => o.id === targetId)) return list;
  const [moved] = display.splice(from, 1);
  // Index AFTER removal, so dragging downward does not land one slot short.
  const at = display.findIndex((o) => o.id === targetId);
  if (at === -1) return list;
  display.splice(edge === "above" ? at : at + 1, 0, moved);
  // First in display order is the topmost, so it takes the highest z.
  const n = display.length;
  return display.map((o, i) => ({ ...o, z: n - i }));
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
  /** For a multi-selection move: start rects of all selected top-level objects
   *  (incl. the dragged one). Present → move the whole group by the same delta. */
  group?: { id: string; x: number; y: number; w: number; h: number }[];
}

// One overlay box (selection outline + move/resize handles), positioned in % of
// its parent overlay node so nested children resolve correctly. Recurses for a
// container's children.
function OverlayNode({
  o, parentAbs, depth, selectedId, selectedIds, draggingId = null, onStart, parentLocked = false,
}: {
  o: LayoutObject;
  parentAbs: FracRect;
  depth: number;
  selectedId: string | null;
  selectedIds: Set<string>;
  /** Id of the object currently being dragged, for a "lifting" cue. */
  draggingId?: string | null;
  onStart: (e: ReactPointerEvent, o: LayoutObject, mode: "move" | Handle, parentAbs: FracRect, depth: number) => void;
  /** True when an ancestor container is locked, so this node is locked too. */
  parentLocked?: boolean;
}) {
  const sel = o.id === selectedId; // single "primary" → resize handles
  const inSel = selectedIds.has(o.id); // any selected → highlight outline
  const dragging = o.id === draggingId;
  const locked = parentLocked || !!o.locked;
  const abs = depth === 0 ? { x: o.x, y: o.y, w: o.w, h: o.h } : composeRect(parentAbs, o);
  const kids = o.children?.length ? [...o.children].sort((a, b) => a.z - b.z) : null;
  return (
    <div
      data-obj-id={o.id}
      onPointerDown={(e) => onStart(e, o, "move", parentAbs, depth)}
      className="absolute"
      style={{
        left: `${o.x * 100}%`, top: `${o.y * 100}%`,
        width: `${o.w * 100}%`, height: `${o.h * 100}%`,
        cursor: locked ? "default" : "move",
        outline: dragging ? "2px dashed #3b82f6" : inSel ? "2px solid #3b82f6" : "1px solid rgba(125,170,255,0.55)",
        outlineOffset: 0,
        opacity: dragging ? 0.7 : 1,
        boxShadow: inSel ? "0 0 0 1px rgba(0,0,0,0.4)" : "0 0 0 1px rgba(0,0,0,0.35)",
      }}
    >
      <span
        style={{
          position: "absolute", top: 0, left: 0, transform: "translateY(-100%)",
          display: "inline-flex", alignItems: "center", gap: 3,
          fontSize: 10, lineHeight: "14px", padding: "0 5px", maxWidth: "100%",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          background: inSel ? "#3b82f6" : "rgba(125,170,255,0.55)", color: "#fff",
          borderRadius: "4px 4px 0 0", pointerEvents: "none",
        }}
      >
        {locked && <LockIcon style={{ width: 9, height: 9 }} />}
        {typeLabel(o.config.type)}
      </span>
      {sel && !locked &&
        HANDLES.map((h) => {
          // Above every sibling overlay node. Nodes render in z order with no
          // z-index of their own, so an object stacked higher than the selected
          // one covered its handles — and since those nodes carry the pointerdown
          // that starts a MOVE, grabbing a corner dragged the wrong object
          // instead of resizing. An object behind anything simply could not be
          // resized, however clearly it was selected.
          //
          // Only the 9px handles are raised, deliberately. Lifting the whole node
          // would also hand it every click over its area, so selecting the object
          // visually on top of it would stop working — trading one unreachable
          // object for another. This node creates no stacking context of its own
          // (opacity 1, no transform), so the handles compete directly with the
          // sibling nodes and win.
          const pos: CSSProperties = { position: "absolute", width: 9, height: 9, background: "#3b82f6", borderRadius: 2, zIndex: 10 };
          if (h.includes("n")) pos.top = -5;
          if (h.includes("s")) pos.bottom = -5;
          if (h.includes("w")) pos.left = -5;
          if (h.includes("e")) pos.right = -5;
          if (h === "n" || h === "s") pos.left = "calc(50% - 4.5px)";
          if (h === "e" || h === "w") pos.top = "calc(50% - 4.5px)";
          return <div key={h} onPointerDown={(e) => onStart(e, o, h, parentAbs, depth)} style={{ ...pos, cursor: handleCursor(h) }} />;
        })}
      {kids?.map((c) => (
        <OverlayNode key={c.id} o={c} parentAbs={abs} depth={depth + 1} selectedId={selectedId} selectedIds={selectedIds} draggingId={draggingId} onStart={onStart} parentLocked={locked} />
      ))}
    </div>
  );
}

function EditorCanvas({
  canvas, objects, selectedId, selectedIds, gridOn, ctx, ndiSource, interactive,
  onSelect, onMarqueeSelect, onGeom, onGeomMany, onCommitStart, onReparent, onBoxSize,
  onContextMenu,
}: {
  canvas: LayoutCanvas;
  objects: LayoutObject[];
  selectedId: string | null;
  selectedIds: Set<string>;
  gridOn: boolean;
  ctx: Omit<LayoutRenderCtx, "H" | "ndiSource" | "interactive">;
  ndiSource: string | null;
  /** When false the canvas is a read-only preview (no overlay, handles, or drag). */
  interactive: boolean;
  onSelect: (id: string | null, additive?: boolean) => void;
  /** Marquee drag on empty canvas → select all top-level objects it intersects. */
  onMarqueeSelect: (ids: string[], additive: boolean) => void;
  onGeom: (id: string, geom: Pick<LayoutObject, "x" | "y" | "w" | "h">) => void;
  /** Apply geometry to several objects at once (group move). */
  onGeomMany: (updates: { id: string; geom: Pick<LayoutObject, "x" | "y" | "w" | "h"> }[]) => void;
  onCommitStart: () => void;
  /** Reports the rendered canvas box size so the parent's snap actions (Snap all /
   *  Snap to grid) use the same grid aspect as the canvas. */
  onBoxSize?: (w: number, h: number) => void;
  /** Drop a top-level object into a container (reparent on drag release).
   *  `objAbs` is the object's final absolute canvas rect; `containerAbs` the
   *  container's absolute rect — together they give the new parent-local geom. */
  onReparent: (id: string, containerId: string, objAbs: FracRect, containerAbs: FracRect) => void;
  /** Right-click anywhere on the canvas. The handler works out which object (if
   *  any) was under the cursor from `data-obj-id` on the event target. */
  onContextMenu?: (e: ReactMouseEvent) => void;
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

  // "fill" mode: objects reflow to the window rather than letterboxing the design
  // aspect. The PREVIEW still keeps the design aspect, and that is deliberate.
  //
  // It used to take the editor pane's own shape, which made it a model of a
  // display nobody owns: fonts are a fraction of HEIGHT, so a pane that is
  // relatively narrower than the design renders the same text larger relative to
  // the width it has to fit in. Status pills wrapped in the preview and not on the
  // display, and a rundown hid 633px of columns in the preview against 256px on
  // the page — the preview was not just imprecise, it disagreed about what fits.
  //
  // A preview cannot know the shape of the screen this will end up on, so it
  // models the one shape it does know: the design canvas. Same box as letterbox
  // mode; what still differs is `H`, which tracks the live box so the preview is a
  // true scale model rather than a fixed design-space render.
  const fill = canvas.fit === "fill";
  const scale = avail.w > 0 && avail.h > 0 ? Math.min(avail.w / canvas.width, avail.h / canvas.height) : 0;
  const boxW = canvas.width * scale;
  const boxH = canvas.height * scale;
  // Report the box size up so parent snap actions use the same grid aspect.
  useEffect(() => {
    if (boxW > 0 && boxH > 0) onBoxSize?.(boxW, boxH);
    // onBoxSize is a stable useCallback from the parent; deps are the sizes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxW, boxH]);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Marquee (rubber-band) selection on empty canvas: fractional rect while dragging.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The container the dragged object would drop into right now (for the live
  // highlight). Null when not hovering a valid target.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
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
      // Group move: shift every selected top-level object by the same delta as the
      // dragged (primary) one. No reparenting while moving a group.
      if (drag.group) {
        const ddx = geom.x - drag.start.x;
        const ddy = geom.y - drag.start.y;
        onGeomMany(
          drag.group.map((g) => ({
            id: g.id,
            geom: { x: clamp(g.x + ddx, 0, 1 - g.w), y: clamp(g.y + ddy, 0, 1 - g.h), w: g.w, h: g.h },
          })),
        );
        return;
      }
      // Live drop-target highlight while moving a reparentable object.
      if (drag.mode === "move" && drag.canReparent) {
        const target = findDropContainer(drag.targets, drag.start.config.type === "container", geom.x + geom.w / 2, geom.y + geom.h / 2);
        setDropTargetId((prev) => (prev === target ? prev : target));
      }
      onGeom(drag.id, geom);
    };
    const onUp = () => {
      const g = dragGeom.current;
      // Only a lone top-level object dropped onto a container reparents into it.
      if (drag.mode === "move" && drag.canReparent && !drag.group && g) {
        const cx = g.x + g.w / 2;
        const cy = g.y + g.h / 2;
        const target = findDropContainer(drag.targets, drag.start.config.type === "container", cx, cy);
        const t = target ? drag.targets.find((x) => x.id === target) : null;
        // A top-level object's local geom IS its absolute canvas rect.
        if (t) onReparent(drag.id, t.id, { x: g.x, y: g.y, w: g.w, h: g.h }, t.abs);
      }
      dragGeom.current = null;
      setDropTargetId(null);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, boxW, boxH, gridOn, canvas, onGeom, onGeomMany, onReparent]);

  function startDrag(e: ReactPointerEvent, o: LayoutObject, mode: "move" | Handle, parentAbs: FracRect, depth: number) {
    e.stopPropagation();
    e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Shift/Cmd-click toggles selection only — don't start a drag.
    if (additive) { onSelect(o.id, true); return; }
    // Plain click: keep the selection if this object is already part of a multi-
    // selection (so we drag the whole group); otherwise select just this one.
    const inGroup = selectedIds.has(o.id) && selectedIds.size > 1;
    if (!inGroup) onSelect(o.id, false);
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
    const group = mode === "move" && depth === 0 && inGroup
      ? objects
          .filter((obj) => selectedIds.has(obj.id) && !isLockedInTree(objects, obj.id))
          .map((obj) => ({ id: obj.id, x: obj.x, y: obj.y, w: obj.w, h: obj.h }))
      : undefined;
    setDrag({
      id: o.id, mode, start: o, px: e.clientX, py: e.clientY,
      parentW: parentAbs.w * boxW, parentH: parentAbs.h * boxH,
      parentAbs, depth, canReparent: depth === 0, targets, group,
    });
  }

  // Rubber-band select: pointerdown on empty canvas (objects stopPropagation, so
  // only the background reaches here) drags a rectangle; on release, select every
  // top-level object it intersects. A plain click (no drag) clears the selection.
  function startMarquee(e: ReactPointerEvent) {
    // PRIMARY BUTTON ONLY. A right-click also fires pointerdown, and the context
    // menu that follows swallows the matching pointerup — so the move/up listeners
    // below stayed bound to the window and the next mouse movement drew a marquee
    // out of nowhere. Same for middle-click and stylus barrel taps.
    if (e.button !== 0 || !e.isPrimary) return;
    const box = boxRef.current;
    if (!box) { onSelect(null); return; }
    const rect = box.getBoundingClientRect();
    const x0 = (e.clientX - rect.left) / boxW;
    const y0 = (e.clientY - rect.top) / boxH;
    let moved = false;
    const move = (ev: globalThis.PointerEvent) => {
      const x1 = (ev.clientX - rect.left) / boxW;
      const y1 = (ev.clientY - rect.top) / boxH;
      if (Math.abs(x1 - x0) > 0.004 || Math.abs(y1 - y0) > 0.004) moved = true;
      setMarquee({ x0, y0, x1, y1 });
    };
    const up = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMarquee(null);
      if (!moved) { onSelect(null); return; }
      const x1 = (ev.clientX - rect.left) / boxW;
      const y1 = (ev.clientY - rect.top) / boxH;
      const rx0 = Math.min(x0, x1), rx1 = Math.max(x0, x1);
      const ry0 = Math.min(y0, y1), ry1 = Math.max(y0, y1);
      const hits = objects
        .filter((o) => o.x < rx1 && o.x + o.w > rx0 && o.y < ry1 && o.y + o.h > ry0)
        .map((o) => o.id);
      onMarqueeSelect(hits, ev.shiftKey);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const sorted = [...objects].sort((a, b) => a.z - b.z);
  // Editor canvas is never interactive — live-control objects render as static
  // previews here so editing can't fire real PCO commands.
  const fullCtx: LayoutRenderCtx = { ...ctx, H: fill ? boxH : canvas.height, ndiSource, interactive: false };

  // The grid lives INSIDE the content layer (see below) so it shares the object's
  // EXACT box + transform. In letterbox mode that means the grid is drawn once in
  // fixed design-space px and only the transform scale changes on resize (GPU
  // composited, no per-frame reflow) — and Safari can't rasterize the grid on a
  // different pixel grid than the objects. The old sibling boxW×boxH layer used
  // CSS background tiling in screen px while objects were transform-scaled, so the
  // two diverged in Safari (objects off the grid) and jittered while resizing.
  // Cells are SQUARE (same px on both axes) so lines match the snap step exactly.
  const contentW = fill ? boxW : canvas.width;
  const contentH = fill ? boxH : canvas.height;
  const contentCell = contentW / GRID;
  // Keep lines ~1px on screen after the letterbox transform scales the layer down.
  const gridLine = fill || scale <= 0 ? 1 : 1 / scale;
  const gridLayer: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: contentW,
    height: contentH,
    pointerEvents: "none",
    backgroundImage:
      `linear-gradient(rgba(255,255,255,0.06) ${gridLine}px, transparent ${gridLine}px), linear-gradient(90deg, rgba(255,255,255,0.06) ${gridLine}px, transparent ${gridLine}px)`,
    backgroundSize: `${contentCell}px ${contentCell}px`,
  };

  return (
    <div ref={setWrap} className="relative w-full h-full flex items-start justify-center select-none">
      {boxW > 0 && boxH > 0 && (
        <div
          ref={boxRef}
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
          onPointerDown={interactive ? startMarquee : undefined}
          onContextMenu={interactive && onContextMenu ? onContextMenu : undefined}
        >
          {/* Content layer (visual only). Letterbox: design dims scaled. Fill: the
              layer IS the box (objects positioned by % of the live box). The grid
              is the first child so it shares this layer's exact box + transform —
              objects can never drift off it, in any browser. */}
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
            {gridOn && <div style={gridLayer} />}
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
              {/* Live drop-target highlight: the container the dragged object would
                  land in, drawn behind the selection boxes. */}
              {dropTargetId && drag && (() => {
                const t = drag.targets.find((x) => x.id === dropTargetId);
                if (!t) return null;
                return (
                  <div
                    style={{
                      position: "absolute",
                      left: `${t.abs.x * 100}%`, top: `${t.abs.y * 100}%`,
                      width: `${t.abs.w * 100}%`, height: `${t.abs.h * 100}%`,
                      borderRadius: 6, pointerEvents: "none",
                      outline: "2px dashed var(--green-9)", outlineOffset: -2,
                      background: "rgba(45,212,150,0.12)",
                    }}
                  />
                );
              })()}
              {sorted.map((o) => (
                <OverlayNode
                  key={o.id}
                  o={o}
                  parentAbs={CANVAS_FRAC}
                  depth={0}
                  selectedId={selectedId}
                  selectedIds={selectedIds}
                  draggingId={drag?.id ?? null}
                  onStart={startDrag}
                />
              ))}
            </div>
          )}
          {interactive && marquee && (
            <div
              style={{
                position: "absolute",
                left: `${Math.min(marquee.x0, marquee.x1) * 100}%`,
                top: `${Math.min(marquee.y0, marquee.y1) * 100}%`,
                width: `${Math.abs(marquee.x1 - marquee.x0) * 100}%`,
                height: `${Math.abs(marquee.y1 - marquee.y0) * 100}%`,
                border: "1px solid #3b82f6",
                background: "rgba(59,130,246,0.12)",
                pointerEvents: "none",
                zIndex: 20,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── small inspector row helpers ──────────────────────────────────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-caption2 text-fg-muted w-24 shrink-0 flex items-center gap-1">
        <span className="truncate">{label}</span>
        {hint && <InfoHint className="shrink-0">{hint}</InfoHint>}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-1">{children}</div>
    </div>
  );
}

// ── Declarative inspector rows ───────────────────────────────────────────────
// Thin label+control wrappers so each object's inspector block reads as a list
// of options and every control is laid out consistently. Bespoke controls
// (live-data selects, list editors) still use <Row> directly.

function RowSwitch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <Row label={label} hint={hint}><Switch checked={checked} onCheckedChange={onChange} /></Row>;
}

function RowText({ label, hint, value, placeholder, onChange }: { label: string; hint?: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <Row label={label} hint={hint}>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="text-fg" />
    </Row>
  );
}

/** Image object config: a URL field (external https / existing) plus an upload
 *  button that stores a local file server-side and sets src to the returned URL —
 *  so the bytes never live in the layout JSON (which rides in stage:state). */
function ImageConfig({ src, onChange }: { src: string; onChange: (v: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("Couldn't read the file"));
        r.readAsDataURL(file);
      });
      const { url } = await invoke<{ url: string }>("layout:uploadImage", { dataUrl });
      onChange(url);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RowText label="URL" value={src} placeholder="https://… or upload →" onChange={onChange} />
      <Row label="Upload">
        <div className="flex items-center gap-2 min-w-0">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
          <Button variant="filled" size="small" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Uploading…" : "Choose image…"}
          </Button>
          {src.startsWith("/layout-images/") && <span className="text-caption2 text-green-10 shrink-0">uploaded ✓</span>}
          {err && <span className="text-caption2 text-red-11 truncate">{err}</span>}
        </div>
      </Row>
    </>
  );
}

function RowNumber({ label, hint, value, step, min, max, onChange }: { label: string; hint?: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return <Row label={label} hint={hint}><NumberInput value={value} step={step} min={min} max={max} onChange={onChange} /></Row>;
}

/** A segmented (accent/filled) button toggle — the most repeated inspector control. */
function RowToggle<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <ButtonGroup>
        {options.map((o) => (
          <Button key={o.value} variant={value === o.value ? "accent" : "filled"} size="small" onClick={() => onChange(o.value)}>
            {o.label}
          </Button>
        ))}
      </ButtonGroup>
    </Row>
  );
}

/** A labeled dropdown row (for when there are more options than fit a toggle). */
function RowSelect({ label, hint, value, options, onChange }: { label: string; hint?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <Row label={label} hint={hint}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

const RECORDED_LATEST = "__latest__";

/** Inspector controls for the people-graph object: live vs. a recorded service,
 *  PCO markers, hover tooltip, and a kiosk-visible live/recorded toggle. */
function PeopleGraphInspector({ c, onConfig }: { c: Extract<LayoutObjectConfig, { type: "people-graph" }>; onConfig: (c: LayoutObjectConfig) => void }) {
  const source = c.source ?? "live";
  const [services, setServices] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (source !== "recorded") return;
    invoke<ServiceAttendance[]>("attendance:listHistory")
      .then((list) =>
        setServices(
          (list ?? [])
            .filter((s) => s.endedAt)
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
            .map((s) => {
              const d = new Date(s.startedAt);
              const when = `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
              return { value: s.serviceKey, label: s.serviceTypeName ? `${when} — ${s.serviceTypeName}` : when };
            }),
        ),
      )
      .catch(() => setServices([]));
  }, [source]);

  return (
    <>
      <RowToggle
        label="Count"
        value={c.metric ?? "occupancy"}
        options={[{ value: "attendance", label: "Attendance" }, { value: "occupancy", label: "In room" }]}
        onChange={(v) => onConfig({ ...c, metric: v })}
      />
      <RowSwitch label="Show value" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
      {(c.showLabel ?? true) && (
        <RowText label="Label" value={c.label ?? ""} placeholder={c.metric === "attendance" ? "Attendance" : "In room"} onChange={(v) => onConfig({ ...c, label: v })} />
      )}
      <RowToggle
        label="Source"
        value={source}
        options={[{ value: "live", label: "Live" }, { value: "recorded", label: "Recorded" }]}
        onChange={(v) => onConfig({ ...c, source: v as "live" | "recorded" })}
      />
      {source === "recorded" && (
        <RowSelect
          label="Service"
          hint="Which past service's curve to show. 'Most recent' auto-follows the latest finished service."
          value={c.recordedServiceKey || RECORDED_LATEST}
          options={[{ value: RECORDED_LATEST, label: "Most recent" }, ...services]}
          onChange={(v) => onConfig({ ...c, recordedServiceKey: v === RECORDED_LATEST ? null : v })}
        />
      )}
      <RowSwitch label="Plan-item markers" hint="Overlay a dashed line + time where each PCO item started." checked={c.showMarkers ?? true} onChange={(v) => onConfig({ ...c, showMarkers: v })} />
      <RowSwitch label="Hover tooltip" hint="Show the value + time at the pointer." checked={c.showTooltip ?? true} onChange={(v) => onConfig({ ...c, showTooltip: v })} />
      <RowSwitch label="Kiosk live/recorded toggle" hint="Show an on-screen pill so a viewer can flip between live and the last recorded service." checked={c.kioskToggle ?? false} onChange={(v) => onConfig({ ...c, kioskToggle: v })} />
      <p className="text-caption2 text-fg-muted leading-snug">Live builds a rolling trend while the server runs; Recorded replays a finished service. Line color is the object's text color below.</p>
    </>
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
      <span className="text-caption2 text-fg-muted w-3.5 shrink-0">{label}</span>
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
  // Multi-selection is the source of truth; `selectedId` is the single primary
  // (for the inspector + resize handles) and is null unless exactly one is picked.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initial.objects[0] ? [initial.objects[0].id] : []),
  );
  const selectedId = selectedIds.size === 1 ? [...selectedIds][0] : null;
  // Select an object; additive (shift/ctrl/cmd) toggles it in/out of the selection.
  function selectObject(id: string | null, additive = false) {
    if (id === null) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds((prev) => {
      if (!additive) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Select several objects at once (marquee). Additive (shift) keeps the current set.
  function selectMany(ids: string[], additive: boolean) {
    setSelectedIds((prev) => {
      if (!additive) return new Set(ids);
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }
  // In-editor clipboard for Cmd/Ctrl-C / -V (stores fresh-id clones).
  const clipboard = useRef<LayoutObject[]>([]);
  // Right-click menu: where it opened, and which object was under the cursor.
  // Items are captured when the menu OPENS, not rebuilt on render: they depend on
  // the clipboard, which is a ref, and a menu should describe the moment it was
  // summoned rather than quietly re-deciding underneath the cursor.
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  // Layers-panel drag-to-reorder: where the dragged row would land — a row and
  // which SIDE of it, not just which row. Highlighting the row itself could not
  // say whether the drop lands above or below it, and the old "always insert
  // before the target" rule left the top of the list unreachable: you had to drop
  // below the second row and then drag the former top one down past it.
  const [dragLayerOver, setDragLayerOver] = useState<{ id: string; edge: "above" | "below" } | null>(null);
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

  // Which integrations are set up — drives the add-object palette's setup-aware
  // dimming. Reflects "configured" (creds/config saved), NOT the live connection,
  // so a set-up-but-disconnected integration's objects stay available.
  const configuredIntegrations = useConfiguredIntegrations();
  // Opt-in: hide palette objects whose integration isn't set up (default off).
  const [hideUnconfigured, setHideUnconfigured] = useState(
    () => localStorage.getItem(HIDE_UNCONFIGURED_KEY) === "1",
  );
  const toggleHideUnconfigured = useCallback(() => {
    setHideUnconfigured((v) => {
      const next = !v;
      try { localStorage.setItem(HIDE_UNCONFIGURED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
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
  // Available height from the canvas/panel row's top to the viewport bottom — the
  // inspector panel is capped to this so it scrolls INTERNALLY (see the side panel
  // below) instead of growing the editor and scrolling the preview out of view.
  const [availH, setAvailH] = useState<number | null>(null);
  useEffect(() => {
    const el = canvasCellRef.current;
    if (!el) return;
    const aspect = canvas.width / canvas.height;
    const measure = () => {
      const width = el.clientWidth;
      const top = el.getBoundingClientRect().top;
      const maxH = Math.max(240, window.innerHeight - top - 16);
      const fit = width > 0 ? width / aspect : maxH;
      // Only clamp to the viewport while editing — there the inline slots editor
      // must sit right below the canvas. When just viewing, fill the width like
      // the read-only ViewPreview so a custom preview isn't shrunk vs other kinds.
      const cap = isEditing ? maxH : Infinity;
      // Aspect-derived in BOTH fit modes. Fill mode used to take the full
      // available height, which gave the preview a shape the design never has —
      // see the box sizing above for why that made the preview disagree with the
      // display about what fits on screen.
      setCanvasH(Math.round(Math.min(fit, cap)));
      // A touch shorter than the raw available height so the section's own bottom
      // padding doesn't tip the page into a few px of scroll.
      setAvailH(Math.max(240, Math.round(maxH) - 12));
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
    setSelectedIds(new Set(initial.objects[0] ? [initial.objects[0].id] : []));
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
    setSelectedIds(new Set());
    setDirty(true);
  }
  // Clear to an empty canvas. Blank is the default for a new custom view; this is
  // the explicit way back to it (templates are optional, not a required start).
  function startFromBlank() {
    pushHistory();
    setObjects([]);
    setSelectedIds(new Set());
    setDirty(true);
  }
  // Replace the layout with the built-in dashboard starter (editable nested tiles).
  function startFromDashboard() {
    pushHistory();
    setObjects(dashboardTemplate());
    setSelectedIds(new Set());
    setDirty(true);
  }
  // Replace the layout with the built-in "Confidence Monitor" starter (the stage
  // mockup: CURRENT hero + huge countdown on the left, NEXT card + 2×2 tiles right).
  function startFromConfidenceMonitor() {
    pushHistory();
    setObjects(confidenceMonitorTemplate());
    setSelectedIds(new Set());
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
    setSelectedIds(new Set([copy.id]));
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
  // Geometry for several objects at once (group move) — one state update.
  const onGeomMany = useCallback((updates: { id: string; geom: Pick<LayoutObject, "x" | "y" | "w" | "h"> }[]) => {
    setObjects((prev) => updates.reduce((tree, u) => mapById(tree, u.id, (o) => ({ ...o, ...u.geom })), prev));
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
      setSelectedIds(new Set([child.id]));
    } else {
      const o = makeObject(type, zTop + 1);
      // Snap a new top-level object onto the square grid so its edges land on lines.
      const sn = snapRectToGrid({ x: o.x, y: o.y, w: o.w, h: o.h }, CANVAS_FRAC, editorBox.w || canvas.width, editorBox.h || canvas.height, true);
      setObjects((prev) => [...prev, { ...o, ...sn }]);
      setSelectedIds(new Set([o.id]));
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
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
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
    setSelectedIds(new Set([copy.id]));
  }
  // Clone the given objects (fresh ids, offset) into a working tree; returns the
  // new tree + the fresh ids. Preserves each object's parent when duplicating.
  function cloneInto(tree: LayoutObject[], srcs: LayoutObject[], keepParent: boolean): { tree: LayoutObject[]; ids: Set<string> } {
    let out = tree;
    const ids = new Set<string>();
    for (const s of srcs) {
      const siblings = keepParent ? getSiblings(out, s.id) : out;
      const z = siblings.reduce((m, o) => Math.max(m, o.z), 0) + 1;
      const copy: LayoutObject = {
        ...deepCloneFreshIds(s, uid),
        x: clamp(s.x + 0.03, 0, 1 - s.w),
        y: clamp(s.y + 0.03, 0, 1 - s.h),
        z,
      };
      const parent = keepParent ? getParentOf(out, s.id) : null;
      out = parent ? insertChild(out, parent.id, copy) : [...out, copy];
      ids.add(copy.id);
    }
    return { tree: out, ids };
  }
  // Bulk actions. The *Ids forms take the selection explicitly, because the
  // right-click menu decides what it is acting on BEFORE setSelectedIds has
  // landed — reading state there would act on the previous selection.
  function removeSelected() {
    removeIds(selectedIds);
  }
  function removeIds(selection: Set<string>) {
    const ids = [...selection].filter((id) => !isLockedInTree(objects, id));
    if (ids.length === 0) return;
    pushHistory();
    setObjects((prev) => ids.reduce((tree, id) => removeById(tree, id).tree, prev));
    setSelectedIds(new Set());
    setDirty(true);
  }
  function duplicateSelected() {
    duplicateIds(selectedIds);
  }
  function duplicateIds(selection: Set<string>) {
    const srcs = [...selection].map((id) => findById(objects, id)).filter((o): o is LayoutObject => !!o);
    if (srcs.length === 0) return;
    pushHistory();
    const { tree, ids } = cloneInto(objects, srcs, true);
    setObjects(tree);
    setSelectedIds(ids);
    setDirty(true);
  }
  // Cmd/Ctrl-C / -V. Copy snapshots the selection; paste drops fresh clones at the
  // top level (offset) and selects them.
  function copySelected() {
    copyIds(selectedIds);
  }
  function copyIds(selection: Set<string>) {
    const srcs = [...selection].map((id) => findById(objects, id)).filter((o): o is LayoutObject => !!o);
    if (srcs.length) clipboard.current = srcs.map((o) => deepCloneFreshIds(o, uid));
  }
  function pasteClipboard() {
    if (clipboard.current.length === 0) return;
    pushHistory();
    const { tree, ids } = cloneInto(objects, clipboard.current, false);
    setObjects(tree);
    setSelectedIds(ids);
    setDirty(true);
  }
  /** Right-click on the canvas: select what is under the cursor, then open the menu. */
  function openContextMenu(e: ReactMouseEvent) {
    e.preventDefault();
    const el = (e.target as HTMLElement | null)?.closest?.("[data-obj-id]") as HTMLElement | null;
    const objectId = el?.dataset.objId ?? null;
    // Right-clicking an object that is not in the selection selects it first, so
    // the menu always acts on what was actually clicked. Right-clicking one that
    // IS selected keeps the whole selection, so "Delete" can act on all of it.
    // The selection the menu will act on. Computed here rather than read back
    // from state, which has not updated yet inside this handler.
    let selection = selectedIds;
    if (objectId && !selectedIds.has(objectId)) selection = new Set([objectId]);
    else if (!objectId) selection = new Set();
    if (selection !== selectedIds) setSelectedIds(selection);
    setMenu({ x: e.clientX, y: e.clientY, items: contextMenuItems(selection) });
  }

  /** Items for the current right-click, built fresh so counts and enablement are
   *  right at the moment it opens. */
  function contextMenuItems(selection: Set<string>): ContextMenuItem[] {
    const count = selection.size;
    const many = count > 1 ? ` (${count})` : "";
    const addSub: ContextMenuItem[] = PALETTE_GROUPS.flatMap((g) => {
      const types = g.types.filter((t) => {
        const need = objectIntegration(t);
        return !(hideUnconfigured && need && !configuredIntegrations.has(need.id));
      });
      if (types.length === 0) return [];
      return [
        { separator: true } as ContextMenuItem,
        ...types.map((t) => ({ label: typeLabel(t), onSelect: () => addObject(t) })),
      ];
    }).slice(1); // drop the leading separator

    return [
      { label: "Add object", items: addSub },
      { separator: true },
      { label: `Copy${many}`, shortcut: "⌘C", disabled: count === 0, onSelect: () => copyIds(selection) },
      { label: "Paste", shortcut: "⌘V", disabled: clipboard.current.length === 0, onSelect: pasteClipboard },
      { label: `Duplicate${many}`, shortcut: "⌘D", disabled: count === 0, onSelect: () => duplicateIds(selection) },
      { separator: true },
      { label: `Delete${many}`, shortcut: "⌫", danger: true, disabled: count === 0, onSelect: () => removeIds(selection) },
    ];
  }

  // Keyboard: Delete/Backspace removes the selection; Cmd/Ctrl-D duplicates,
  // -C copies, -V pastes. Ignored while typing in a form field.
  useEffect(() => {
    if (!isEditing) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) { e.preventDefault(); removeSelected(); }
      else if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); }
      else if (mod && (e.key === "c" || e.key === "C") && selectedIds.size > 0) { e.preventDefault(); copySelected(); }
      else if (mod && (e.key === "v" || e.key === "V") && clipboard.current.length > 0) { e.preventDefault(); pasteClipboard(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Handlers close over selectedIds/objects; re-bind when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, selectedIds, objects]);
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
    setSelectedIds(new Set([id]));
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

  // Drag-to-reorder in the Layers panel: drop `id` above or below `targetId`,
  // within the same sibling scope (a cross-parent drop is ignored, keeping z sane).
  function moveLayer(id: string, targetId: string, edge: "above" | "below") {
    if (id === targetId) return;
    const pa = getParentOf(objects, id);
    const pb = getParentOf(objects, targetId);
    if ((pa?.id ?? null) !== (pb?.id ?? null)) return; // different scopes — no-op
    pushHistory();
    setObjects((prev) => {
      const parent = getParentOf(prev, id);
      return parent
        ? mapById(prev, parent.id, (p) => ({ ...p, children: reorderLayerScope(p.children ?? [], id, targetId, edge) }))
        : reorderLayerScope(prev, id, targetId, edge);
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
    <div className="relative flex flex-col gap-3 @container h-full min-h-0">
      {/* Unsaved-changes banner — a compact pill in a zero-height, right-aligned
          STICKY anchor: it stays pinned to the top as the editor scrolls (always
          visible) yet reserves no layout space, so it never shifts content down.
          pointer-events pass through the empty anchor; only the pill is clickable. */}
      {dirty && (
        <div className="sticky top-1 z-30 h-0 flex justify-end pr-1 pointer-events-none">
          <div className="pointer-events-auto">
            <UnsavedBanner
              compact
              saving={saving}
              onSave={() => void save()}
              onDiscard={discardChanges}
            />
          </div>
        </div>
      )}

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
            {PALETTE_GROUPS.map((g) => {
              const types = g.types.filter((t) => {
                const need = objectIntegration(t);
                // When the hide toggle is on, drop types whose integration isn't set up.
                return !(hideUnconfigured && need && !configuredIntegrations.has(need.id));
              });
              if (types.length === 0) return null;
              return (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {types.map((t) => {
                    const need = objectIntegration(t);
                    // Dim (but keep selectable) when the backing integration isn't set up.
                    // Based on "configured", not connection — a set-up-but-offline
                    // integration's objects stay un-dimmed.
                    const dim = need && !configuredIntegrations.has(need.id);
                    return (
                      <SelectItem key={t} value={t} className={dim ? "opacity-50" : undefined}>
                        {typeLabel(t)}{dim ? ` · set up ${need!.label}` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              );
            })}
          </SelectContent>
        </Select>
        <Button
          variant={hideUnconfigured ? "accent" : "filled"}
          size="small"
          iconOnly
          onClick={toggleHideUnconfigured}
          aria-label={hideUnconfigured ? "Show all objects" : "Hide objects for integrations that aren't set up"}
          tooltip={hideUnconfigured ? "Show objects for integrations that aren't set up" : "Hide objects for integrations that aren't set up"}
        >
          <FilterIcon className="size-3.5" />
        </Button>
        <Button variant={gridOn ? "accent" : "filled"} size="small" onClick={() => setGridOn((v) => !v)} aria-label="Toggle snap grid">
          <Grid3x3Icon className="size-3.5" /> Grid
        </Button>
        <Button variant="filled" size="small" onClick={snapAllToGrid} aria-label="Snap all objects to grid" tooltip="Snap every object's position + size to the grid">
          Snap all
        </Button>
        {/* Canvas size + fit, collapsed into a popover to keep the bar lean. */}
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button variant="filled" size="small" tooltip="Canvas size & fit">
              Canvas <ChevronDownIcon className="size-3.5 text-fg-muted" />
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="start" sideOffset={4} className="z-50 flex w-64 flex-col gap-3 rounded-md border border-line-strong bg-popover p-3 shadow-md backdrop-blur-xl">
              <div className="flex flex-col gap-1.5">
                <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Shape</span>
                <div className="flex flex-wrap gap-1">
                  {CANVAS_PRESETS.map((p) => {
                    const active = p.w === canvas.width && p.h === canvas.height;
                    return (
                      <Tooltip label={p.label}>
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => { setCanvas({ ...canvas, width: p.w, height: p.h }); setDirty(true); }}
                          className={`rounded-md px-2 py-1 text-caption2 tabular-nums transition-colors ${active ? "bg-accent text-on-accent" : "bg-fill text-fg-muted hover:bg-fill-hover hover:text-fg"}`} aria-label={p.label}>
                          {p.id}
                        </button>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Size (px)</span>
                <div className="flex items-center gap-1">
                  <NumberField value={canvas.width} step={10} min={100} onChange={(w) => { if (w >= 100) { setCanvas({ ...canvas, width: Math.round(w) }); setDirty(true); } }} />
                  <span className="text-caption2 text-fg-subtle">×</span>
                  <NumberField value={canvas.height} step={10} min={100} onChange={(h) => { if (h >= 100) { setCanvas({ ...canvas, height: Math.round(h) }); setDirty(true); } }} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Fit</span>
                <ButtonGroup>
                  <Button variant={canvas.fit !== "fill" ? "accent" : "filled"} size="small" onClick={() => { setCanvas({ ...canvas, fit: "contain" }); setDirty(true); }} tooltip="Letterbox: keep the design aspect (adds bars on mismatched screens)">Letterbox</Button>
                  <Button variant={canvas.fit === "fill" ? "accent" : "filled"} size="small" onClick={() => { setCanvas({ ...canvas, fit: "fill" }); setDirty(true); }} tooltip="Fill: use the whole window; objects reflow to its shape (no bars)">Fill</Button>
                </ButtonGroup>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <Button variant="filled" size="small" onClick={undo} disabled={history.length === 0}>
          <UndoIcon className="size-3.5" /> Undo
        </Button>
        {/* Replace the current layout wholesale — starters + saved layouts. */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button variant="filled" size="small" tooltip="Replace the current layout with a starter or a saved layout">
              <LayoutTemplateIcon className="size-3.5" /> Replace
              <ChevronDownIcon className="size-3.5 text-fg-muted" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-52 rounded-md border border-line-strong bg-popover p-1 shadow-md backdrop-blur-xl">
              <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Replace with…</DropdownMenu.Label>
              <DropdownMenu.Item onSelect={startFromBlank} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill">
                <FilePlusIcon className="size-3.5 text-fg-subtle" /> Blank canvas
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={startFromDashboard} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill">
                <LayoutTemplateIcon className="size-3.5 text-fg-subtle" /> Dashboard template
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={startFromConfidenceMonitor} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill">
                <LayoutTemplateIcon className="size-3.5 text-fg-subtle" /> Confidence Monitor template
              </DropdownMenu.Item>
              {templates.length > 0 && (
                <>
                  <DropdownMenu.Separator className="my-1 h-px bg-line" />
                  <DropdownMenu.Label className="px-2 pb-1 pt-0.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">Saved layouts</DropdownMenu.Label>
                  {templates.map((t) => (
                    <DropdownMenu.Item key={t.id} onSelect={() => loadTemplate(t)} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill">
                      {t.name}
                    </DropdownMenu.Item>
                  ))}
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
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
            className="text-fg"
            autoFocus
          />
        </Dialog>

        <div className="flex-1" />
        {/* Save/Discard live in the floating unsaved pill when dirty — no separate
            toolbar Save button (it duplicated the pill's Save). "Done" exits (and
            prompts to save if there are unsaved changes). */}
        <Button variant="filled" size="small" onClick={leaveEditMode}>
          <CheckIcon className="size-3.5" /> Done
        </Button>
      </div>
      )}

      {/* Fill the editor height so the side panel can use the full window height —
          except while editing an inline slots-grid, where the row stays preview-tall
          so the InlineSlotsEditor below it stays reachable without a huge gap. */}
      <div className={`flex gap-3 @max-4xl:flex-col min-h-0 ${!inlineGrid ? "flex-1" : ""}`}>
        {/* Canvas — height derived from its width + the design aspect (capped at
            the viewport), so it has a definite size, never jumps, and the inline
            slots editor sits right below it. */}
        <div ref={canvasCellRef} className="flex-1 min-w-0 @max-4xl:flex-none" style={{ height: canvasH ?? undefined }}>
          {data.state ? (
            <EditorCanvas
              canvas={canvas}
              objects={objects}
              selectedId={selectedId}
              selectedIds={selectedIds}
              gridOn={gridOn && isEditing}
              interactive={isEditing}
              ctx={{ ...data, state: data.state, integrations: data.integrationsSnap.states, integrationLabels: data.integrationsSnap.labels, servicePeak: data.servicePeaks.occupancy, servicePeakAttendance: data.servicePeaks.attendance }}
              ndiSource={view.ndiSource ?? null}
              onSelect={selectObject}
              onMarqueeSelect={selectMany}
              onGeomMany={onGeomMany}
              onGeom={onGeom}
              onCommitStart={pushHistory}
              onReparent={reparentIntoContainer}
              onBoxSize={handleBoxSize}
              onContextMenu={isEditing ? openContextMenu : undefined}
            />
          ) : (
            <div className="w-full h-full rounded-xl border border-line flex items-center justify-center text-fg-subtle">
              Loading…
            </div>
          )}
        </div>

        {/* Right-click menu. Positioned fixed to the viewport, so it lives outside
            the canvas box rather than inside its ternary. */}
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menu.items}
            onClose={() => setMenu(null)}
          />
        )}

        {/* Side panel: layers + inspector (edit mode only). Capped to the canvas
            height (which is measured to reach the viewport bottom) and scrolls
            INTERNALLY, so paging through inspector options never scrolls the whole
            editor and pushes the preview out of view. */}
        {isEditing && (
        <div className="w-80 @6xl:w-96 shrink-0 flex flex-col gap-3 min-h-0 overflow-y-auto @max-4xl:w-full" style={{ maxHeight: (inlineGrid ? canvasH : availH) ?? undefined }}>
          {/* Layers */}
          <div className="flex flex-col gap-1">
            <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">Layers</span>
            {layerRows.length === 0 && <span className="text-caption2 text-fg-subtle">No objects yet — add one above.</span>}
            {layerRows.map(({ o, depth }) => (
              <button
                key={o.id}
                type="button"
                draggable
                onClick={(e) => selectObject(o.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                onDragStart={(e) => { e.dataTransfer.setData("text/plain", o.id); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  // Which half of the row the pointer is in decides the side. The
                  // line then sits exactly where the row will land, so the gap you
                  // aim at is the gap you get.
                  const r = e.currentTarget.getBoundingClientRect();
                  const edge = e.clientY < r.top + r.height / 2 ? "above" : "below";
                  if (dragLayerOver?.id !== o.id || dragLayerOver.edge !== edge) setDragLayerOver({ id: o.id, edge });
                }}
                onDragLeave={() => setDragLayerOver((cur) => (cur?.id === o.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  const src = e.dataTransfer.getData("text/plain");
                  const edge = dragLayerOver?.id === o.id ? dragLayerOver.edge : "above";
                  setDragLayerOver(null);
                  if (src) moveLayer(src, o.id, edge);
                }}
                style={{ paddingLeft: 8 + depth * 14 }}
                className={`relative flex items-center gap-1.5 rounded-md pr-2 py-1 text-left cursor-grab active:cursor-grabbing ${selectedIds.has(o.id) ? "bg-fill-active" : "hover:bg-fill"}`}
              >
                {/* The insertion line. Drawn on the row's own edge rather than in
                    the gap between rows: the gap is not a drop target of its own,
                    so a line living there would flicker as the pointer crossed it.
                    `pointer-events: none` so it cannot swallow the drop it marks. */}
                {dragLayerOver?.id === o.id && (
                  <span
                    aria-hidden
                    className="absolute left-0 right-0 h-0.5 rounded-full bg-focus"
                    style={{ [dragLayerOver.edge === "above" ? "top" : "bottom"]: -1, pointerEvents: "none" }}
                  />
                )}
                <span className="text-caption1 text-fg flex-1 min-w-0 truncate">
                  {o.config.type === "container" ? `${typeLabel(o.config.type)} (${o.children?.length ?? 0})` : typeLabel(o.config.type)}
                </span>
                {depth > 0 && (
                  <Tooltip label="Move out of container">
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); reparentToRoot(o.id); }}
                      className="text-fg-muted hover:text-fg"
                      aria-label="Move out of container"
                    >
                      <CornerLeftUpIcon className="size-3.5" />
                    </span>
                  </Tooltip>
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); pushHistory(); update(o.id, { locked: !o.locked }); }}
                  className={o.locked ? "text-amber-10" : "text-fg-muted hover:text-fg"}
                  aria-label={o.locked ? "Unlock" : "Lock"}
                >
                  {o.locked ? <LockIcon className="size-3.5" /> : <UnlockIcon className="size-3.5" />}
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); pushHistory(); update(o.id, { hidden: !o.hidden }); }}
                  className="text-fg-muted hover:text-fg"
                  aria-label={o.hidden ? "Show" : "Hide"}
                >
                  {o.hidden ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </span>
              </button>
            ))}
          </div>

          {selectedIds.size > 1 && (
            <>
              <Separator />
              <div className="flex flex-col gap-2 p-3">
                <span className="text-caption1 font-medium text-fg">{selectedIds.size} objects selected</span>
                <span className="text-caption2 text-fg-subtle">Shift-click to add or remove · drag a marquee on the canvas to select.</span>
                <div className="flex gap-2">
                  <Button variant="filled" size="small" onClick={duplicateSelected}>
                    <CopyIcon className="size-3.5" /> Duplicate
                  </Button>
                  <Button variant="filled" size="small" onClick={removeSelected}>
                    <Trash2Icon className="size-3.5 text-red-10" /> Delete
                  </Button>
                </div>
              </div>
            </>
          )}

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
                <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">Saved layouts</span>
                {templates.map((t) => (
                  <div key={t.id} className="flex items-center gap-0.5 rounded-md px-2 py-1 hover:bg-fill">
                    <span className="text-caption1 text-fg flex-1 min-w-0 truncate">{t.name}</span>
                    <Button variant="transparent" size="small" iconOnly onClick={() => loadTemplate(t)} aria-label="Load into editor" tooltip="Load into editor">
                      <DownloadIcon className="size-3.5 text-fg-muted" />
                    </Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => onUpdateTemplate(t.id, { layout: currentLayout() })} aria-label="Overwrite with current" tooltip="Overwrite with current layout">
                      <SaveIcon className="size-3.5 text-fg-muted" />
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
            <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">Saved groups</span>
            {groups.length === 0 ? (
              <span className="text-caption2 text-fg-muted">Select a container and use the package icon in the inspector to save it as a reusable group.</span>
            ) : (
              groups.map((g) => (
                <div key={g.id} className="flex items-center gap-0.5 rounded-md px-2 py-1 hover:bg-fill">
                  <span className="text-caption1 text-fg flex-1 min-w-0 truncate">{g.name}</span>
                  <Button variant="transparent" size="small" iconOnly onClick={() => insertGroup(g)} aria-label="Insert group" tooltip="Insert into this view">
                    <DownloadIcon className="size-3.5 text-fg-muted" />
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
            className="text-fg"
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
    onConfig({ ...c, crop: { ...crop, [side]: clamp(pct, 0, 95) / 100 } });

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
        onGeom({ h: clamp(newH, 0.03, 1 - o.y) });
      }
    } finally {
      setFitting(false);
    }
  }

  return (
    <>
      <Row label="Match" hint="Substring of the PCO attachment's filename to show (e.g. 'stage plot'). It auto-picks any matching PDF/image on the live plan, so it keeps working each week if you name files consistently.">
        <Input
          value={c.match ?? "stage plot"}
          onChange={(e) => onConfig({ ...c, match: e.target.value })}
          placeholder="filename contains…"
          className="text-fg"
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
        <p className="text-caption2 text-fg-muted leading-snug">
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
      <p className="text-caption2 text-fg-muted -mt-1">Top · Bottom · Left · Right</p>
      <Button variant="filled" size="small" onClick={fitBoxToFile} disabled={fitting}>
        {fitting ? "Fitting…" : "Fit box to file"}
      </Button>
    </>
  );
}

/** Object types fed by ProPresenter — they get the per-object instance picker. */
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
  const wirelessChannels = useWirelessChannels();
  const obs = useObsState();
  const reaper = useReaperState();
  const peopleCount = usePeopleCountState();
  const oscTargets = useOscTargets();
  // RossTalk targets + command catalogue for the rosstalk-button inspector. Loaded
  // once here rather than per-object; both are small and change rarely.
  const [rosstalkTargets, setRosstalkTargets] = useState<RossTalkTarget[]>([]);
  const [rosstalkCommands, setRosstalkCommands] = useState<
    { id: string; label: string; family: string; params: RossTalkParam[]; help?: string }[]
  >([]);
  useEffect(() => {
    void invoke<{ targets: RossTalkTarget[] }>("rosstalk:targets")
      .then((r) => setRosstalkTargets(r.targets))
      .catch(() => {});
    void invoke<{ id: string; label: string; family: string; params: RossTalkParam[]; help?: string }[]>(
      "rosstalk:commands",
    )
      .then(setRosstalkCommands)
      .catch(() => {});
  }, []);
  const planItems = usePlanItems();
  const propInstances = usePropInstances();
  const integrationsSnap = useIntegrations();
  const captionChannels = Object.keys(useStageState().state?.captionChannelColors ?? {});
  const embedViews = useStageState().state?.views ?? [];
  const isText = !["shape", "container", "ndi-video", "slide-thumbnail", "image", "plan-attachment", "brand-logo", "slots-grid"].includes(c.type);
  // Style sizes are stored as fractions of canvas HEIGHT; show them as px (rounded
  // to 1 decimal so they read as whole numbers but still allow fine values).
  const pxOf = (frac: number | undefined, dflt: number) => Math.round((frac ?? dflt) * canvas.height * 10) / 10;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1">
        <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted flex-1">{typeLabel(c.type)}</span>
        {c.type === "container" && (
          <Button variant="transparent" size="small" iconOnly onClick={onSaveGroup} aria-label="Save as group"><PackagePlusIcon className="size-3.5 text-fg-muted" /></Button>
        )}
        <Button variant="transparent" size="small" iconOnly disabled={locked} onClick={onSnapToGrid} aria-label="Snap to grid" tooltip="Snap position + size to the grid"><Grid3x3Icon className="size-3.5 text-fg-muted" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onToggleLock} aria-label={o.locked ? "Unlock" : "Lock"}>
          {o.locked ? <LockIcon className="size-3.5 text-amber-10" /> : <UnlockIcon className="size-3.5 text-fg-muted" />}
        </Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("front")} aria-label="Bring to front" tooltip="Bring to front"><ChevronsUpIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("up")} aria-label="Bring forward" tooltip="Bring forward"><ChevronUpIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("down")} aria-label="Send backward" tooltip="Send backward"><ChevronDownIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={() => onReorder("back")} aria-label="Send to back" tooltip="Send to back"><ChevronsDownIcon className="size-3.5" /></Button>
        <Button variant="transparent" size="small" iconOnly onClick={onDuplicate} aria-label="Duplicate"><CopyIcon className="size-3.5 text-fg-muted" /></Button>
        <Button variant="transparent" size="small" iconOnly disabled={locked} onClick={onRemove} aria-label="Delete"><Trash2Icon className={`size-3.5 ${locked ? "text-fg-subtle" : "text-red-10"}`} /></Button>
      </div>

      {nested && (
        <Button variant="filled" size="small" onClick={onReparentOut}>
          <CornerLeftUpIcon className="size-3.5" /> Move out of container
        </Button>
      )}

      {/* ProPresenter instance picker — only when >1 instance is configured
          (two-auditorium setups); otherwise everything reads the primary. */}
      {usesPropInstance(c.type) && propInstances && propInstances.list.length > 1 && (
        <RowSelect
          label="ProPresenter"
          hint="Which ProPresenter machine this object reads from — for multi-auditorium setups. Defaults to the primary instance; pick another to point this object at a second room's ProPresenter."
          value={(c as { propresenterInstanceId?: string | null }).propresenterInstanceId ?? "default"}
          options={propInstances.list.map((i) => ({ value: i.id, label: i.name }))}
          onChange={(v) => onConfig({ ...c, propresenterInstanceId: v === "default" ? null : v } as LayoutObjectConfig)}
        />
      )}

      {/* Binding */}
      {c.type === "text" && (
        <RowText label="Text" value={c.text} onChange={(v) => onConfig({ type: "text", text: v })} />
      )}
      {c.type === "clock" && (
        <>
          <RowToggle
            label="Format"
            value={c.format === "24h" ? "24h" : "12h"}
            options={[{ value: "12h", label: "12h" }, { value: "24h", label: "24h" }]}
            onChange={(v) => onConfig({ ...c, format: v })}
          />
          <RowSwitch label="Seconds" checked={c.showSeconds ?? true} onChange={(v) => onConfig({ ...c, showSeconds: v })} />
          {c.format !== "24h" && (
            <RowSwitch label="AM / PM" checked={c.showMeridiem ?? true} onChange={(v) => onConfig({ ...c, showMeridiem: v })} />
          )}
        </>
      )}
      {c.type === "section-chip" && (
        <Row label="Which" hint="Which ProPresenter section to show. Current/Next follow the presentation's sections; Next section skips arrangement breaks to the next actual song/item.">
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
      {c.type === "pp-timer" && (
        <>
          <RowText
            label="Timer name"
            hint="Exact name of a timer running INSIDE ProPresenter — distinct from the PCO countdown. Leave blank to show the first timer ProPresenter reports."
            value={c.timerName ?? ""}
            placeholder="First timer"
            onChange={(v) => onConfig({ ...c, timerName: v.trim() || null })}
          />
          <RowSwitch label="Color on overrun" checked={c.warnStates ?? true} onChange={(v) => onConfig({ ...c, warnStates: v })} />
          <RowSwitch label="Show timer name" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
        </>
      )}
      {c.type === "slide-progress" && (
        <>
          <RowToggle
            label="Display"
            value={c.display ?? "fraction"}
            options={[
              { value: "fraction", label: "3 / 12" },
              { value: "remaining", label: "Left" },
              { value: "percent", label: "%" },
              { value: "bar", label: "Bar" },
            ]}
            onChange={(v) => onConfig({ ...c, display: v })}
          />
          {(c.display ?? "fraction") !== "bar" && (
            <RowSwitch label="Show 'slides' label" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          )}
        </>
      )}
      {(() => {
        // A retired type: still rendered so an old layout keeps working, out of
        // the palette so no new ones appear, with the conversion one click away.
        // Deliberately NOT automatic — the replacement renders a different table,
        // and silently changing what is on a stage monitor is not an upgrade.
        const retired = objectRetired(c.type);
        if (!retired) return null;
        const scriptViews = (embedViews ?? []).filter((v) => v.kind === "script");
        return (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-a5 bg-amber-a2 p-3">
            <span className="text-caption1 text-fg">This object has been replaced</span>
            <span className="text-caption2 text-fg-muted">{retired.why}</span>
            <span className="text-caption2 text-fg-muted">
              It is not a like-for-like swap, so read this first: the replacement
              scrolls rather than shrinking to fit, and <strong>Fit to height</strong>,{" "}
              <strong>Scroll</strong> and the note-category picker do not carry over.
              Its columns come from the Script view's preset instead. Set the object's
              font size afterwards — nothing auto-fits it now.
            </span>
            <Button
              variant="filled"
              size="small"
              className="self-start"
              onClick={() =>
                onConfig({
                  type: "view-embed",
                  // Only auto-pick when there is no ambiguity; otherwise leave it
                  // for the picker rather than guessing which view was meant.
                  viewId: scriptViews.length === 1 ? scriptViews[0].id : null,
                  showHeader: false,
                } as LayoutObjectConfig)
              }
            >
              Convert to Embedded view
            </Button>
            {scriptViews.length === 0 && (
              <span className="text-caption2 text-fg-subtle">
                Make a Script view first and this will have something to point at.
              </span>
            )}
          </div>
        );
      })()}
      {c.type === "view-embed" && (() => {
        // Both the picker and the renderer ask the same function — see
        // isEmbeddableViewKind. Custom never appears, which IS the recursion
        // guard; other kinds appear but say why they do not render yet.
        const embeddable = (embedViews ?? []).filter((v) => isOfferableInEmbedPicker(v.kind));
        return embeddable.length === 0 ? (
          <p className="text-caption2 text-fg-muted">
            No embeddable views yet — make a Script view first, then point this at it.
          </p>
        ) : (
          <RowSelect
            label="View"
            hint="Renders that view's content here, natively. Script views work today; other kinds are being converted."
            value={c.viewId ?? ""}
            options={[{ value: "", label: "None" }, ...embeddable.map((v) => ({ value: v.id, label: `${v.name} (${v.kind})` }))]}
            onChange={(v) => onConfig({ ...c, viewId: v || null })}
          />
        );
      })()}
      {c.type === "view-embed" && c.viewId && (
        <RowSwitch
          label="Show the view's header"
          checked={c.showHeader ?? false}
          onChange={(v) => onConfig({ ...c, showHeader: v })}
        />
      )}
      {c.type === "service-order" && (
        <>
          <RowToggle
            label="Scroll"
            hint="Follow live: the list auto-scrolls to keep the on-air item in view. Static: the list stays put (the operator scrolls it)."
            value={c.scroll ?? "auto"}
            options={[{ value: "auto", label: "Follow live" }, { value: "static", label: "Static" }]}
            onChange={(v) => onConfig({ ...c, scroll: v })}
          />
          <RowSwitch label="Fit to height" checked={c.autoFit ?? true} onChange={(v) => onConfig({ ...c, autoFit: v })} />
          <RowSwitch label="Highlight live" checked={c.highlightLive ?? true} onChange={(v) => onConfig({ ...c, highlightLive: v })} />
          <RowSwitch label="Show length" checked={c.showLength ?? false} onChange={(v) => onConfig({ ...c, showLength: v })} />
          {(() => {
            const present = planItems?.noteCategories ?? [];
            if (present.length === 0) {
              return <span className="text-caption2 text-fg-muted">Note categories appear once a plan with notes is loaded.</span>;
            }
            // null/undefined = all shown; otherwise the explicit subset.
            const shown = c.noteCategories == null ? present : present.filter((k) => c.noteCategories!.includes(k));
            const toggle = (k: string) => {
              const next = shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k];
              onConfig({ ...c, noteCategories: next });
            };
            return (
              <div className="flex flex-col gap-1">
                <span className="text-caption2 text-fg-muted">Notes shown</span>
                <div className="flex flex-wrap gap-1.5">
                  {present.map((k) => {
                    const on = shown.includes(k);
                    return (
                      <button
                        key={k}
                        onClick={() => toggle(k)}
                        className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${on ? "border-accent/50 bg-accent/12 text-accent" : "border-line-strong bg-fill text-fg-muted hover:bg-fill-hover"}`}
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
          <RowToggle
            label="Mode"
            value={c.mode}
            options={[{ value: "latest", label: "Latest" }, { value: "rolling", label: "Rolling" }]}
            onChange={(v) => onConfig({ ...c, mode: v })}
          />
          {c.mode === "rolling" && (
            <RowNumber label="Lines" value={c.maxLines ?? 3} step={1} min={1} max={10} onChange={(v) => onConfig({ ...c, maxLines: Math.round(v) })} />
          )}
          {captionChannels.length === 0 ? (
            <span className="text-caption2 text-fg-muted">Channels appear here once captions arrive — toggle any to hide.</span>
          ) : (() => {
            const hidden = c.hideChannels ?? [];
            const toggle = (ch: string) => {
              const next = hidden.includes(ch) ? hidden.filter((x) => x !== ch) : [...hidden, ch];
              onConfig({ ...c, hideChannels: next.length ? next : undefined });
            };
            return (
              <div className="flex flex-col gap-1">
                <span className="text-caption2 text-fg-muted">Channels shown</span>
                <div className="flex flex-wrap gap-1.5">
                  {captionChannels.map((ch) => {
                    const on = !hidden.includes(ch);
                    return (
                      <button
                        key={ch}
                        onClick={() => toggle(ch)}
                        className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${on ? "border-accent/50 bg-accent/12 text-accent" : "border-line-strong bg-fill text-fg-muted hover:bg-fill-hover"}`}
                      >
                        {ch}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>
      )}
      {c.type === "integration-status" && (() => {
        const states = integrationsSnap.states;
        return (
          <>
            <Row label="Integration" hint="Which integration's connection status to show. First available shows any that's online; pick a specific one to lock this object to it.">
              <Select value={c.integrationId ?? ""} onValueChange={(v: string) => onConfig({ ...c, integrationId: v || null })}>
                <SelectTrigger><SelectValue placeholder={states.length ? "First available" : "No integrations"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">First available</SelectItem>
                  {states.map((st) => <SelectItem key={st.id} value={st.id}>{integrationsSnap.labels[st.id] ?? st.id}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <RowSwitch label="Show label" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
            {(c.showLabel ?? true) && (
              <RowText label="Label" value={c.label ?? ""} placeholder="integration name" onChange={(v) => onConfig({ ...c, label: v })} />
            )}
          </>
        );
      })()}
      {c.type === "wireless-summary" && (
        <>
          <RowSwitch label="Online count" checked={c.showOnline ?? true} onChange={(v) => onConfig({ ...c, showOnline: v })} />
          <RowSwitch label="Lowest battery" checked={c.showBattery ?? true} onChange={(v) => onConfig({ ...c, showBattery: v })} />
          <RowSwitch label="Show label" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          {(c.showLabel ?? false) && (
            <RowText label="Label" value={c.label ?? ""} placeholder="Mics" onChange={(v) => onConfig({ ...c, label: v })} />
          )}
        </>
      )}
      {c.type === "wireless-channel" && (
        <>
          <Row label="Channel" hint="Which wireless channel this tile shows. Auto uses the first one detected.">
            <Select value={c.channelId ?? ""} onValueChange={(v: string) => onConfig({ ...c, channelId: v || null })}>
              <SelectTrigger><SelectValue placeholder={wirelessChannels.length ? "Auto (first)" : "No channels detected"} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">Auto (first)</SelectItem>
                {wirelessChannels.map((d) => <SelectItem key={d.channelId} value={d.channelId}>{d.name ?? d.channelId}</SelectItem>)}
              </SelectContent>
            </Select>
          </Row>
          <RowSwitch label="RF signal" checked={c.show?.rf ?? true} onChange={(v) => onConfig({ ...c, show: { ...c.show, rf: v } })} />
          <RowSwitch label="Battery %" checked={c.show?.battery ?? true} onChange={(v) => onConfig({ ...c, show: { ...c.show, battery: v } })} />
          <RowSwitch label="Frequency" checked={c.show?.frequency ?? true} onChange={(v) => onConfig({ ...c, show: { ...c.show, frequency: v } })} />
          <RowSwitch label="Audio level" checked={c.show?.audio ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, audio: v } })} />
          <RowSwitch label="Show channel name" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
        </>
      )}
      {c.type === "service-pacing" && (
        <>
          <div className="px-1 pb-1 text-xs text-fg-subtle">
            Shows how far ahead or behind the whole schedule the service is running right now — carries over slippage from earlier items and grows live if the current item runs long. Needs a service-timeline recording.
          </div>
          <Row label="Ahead color">
            <div className="flex items-center gap-2">
              <input type="color" value={hexForInput(c.aheadColor, "#30a46c")} onChange={(e) => onConfig({ ...c, aheadColor: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-line bg-transparent" />
              {c.aheadColor != null && <button type="button" className="text-xs text-fg-subtle hover:text-fg" onClick={() => onConfig({ ...c, aheadColor: null })}>Reset</button>}
            </div>
          </Row>
          <Row label="Behind color">
            <div className="flex items-center gap-2">
              <input type="color" value={hexForInput(c.behindColor, "#e5484d")} onChange={(e) => onConfig({ ...c, behindColor: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-line bg-transparent" />
              {c.behindColor != null && <button type="button" className="text-xs text-fg-subtle hover:text-fg" onClick={() => onConfig({ ...c, behindColor: null })}>Reset</button>}
            </div>
          </Row>
          <RowSwitch label="Show ahead/behind label" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          <RowSwitch label="Show dash when idle" checked={!(c.hideWhenIdle ?? false)} onChange={(v) => onConfig({ ...c, hideWhenIdle: !v })} />
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
              <p className="text-caption2 text-fg-muted leading-snug">Edit this grid's slots below the canvas.</p>
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
          <RowSwitch label="Battery %" checked={c.show.battery ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, battery: v } })} />
          <RowSwitch label="Charging" checked={c.show.charging ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, charging: v } })} />
          <RowSwitch label="Cycles" checked={c.show.cycles ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, cycles: v } })} />
          <RowSwitch label="Health" checked={c.show.health ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, health: v } })} />
          <RowSwitch label="Temp" checked={c.show.temp ?? false} onChange={(v) => onConfig({ ...c, show: { ...c.show, temp: v } })} />
          <div className="flex flex-col gap-1.5 pt-1">
            <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted">Bays</span>
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
                    className="text-fg flex-1"
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
            <Row label="Meter" hint="Which Smaart SPL meter/channel to read. Auto uses the first one detected — pick a specific device/channel if Smaart exposes more than one.">
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
            <Row label="Metric" hint="Which value from the meter to display (e.g. an SPL weighting/response like A-Slow or C-Fast, or Leq). Auto shows the meter's default. Options fill in once Smaart is reporting.">
              <Select value={c.metricKey ?? ""} onValueChange={(v: string) => onConfig({ ...c, metricKey: v || null })}>
                <SelectTrigger><SelectValue placeholder={metricKeys.length ? "Auto" : "No data yet"} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Auto</SelectItem>
                  {metricKeys.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <RowSwitch label="Show metric name" checked={c.showLabel ?? false} onChange={(v) => onConfig({ ...c, showLabel: v })} />
            <RowSwitch label="Peak hold" hint="Also show the highest reading seen, held on screen — useful for catching transient peaks during loud moments." checked={c.peakHold ?? false} onChange={(v) => onConfig({ ...c, peakHold: v })} />
            <RowSwitch label="Color thresholds" checked={!!t} onChange={(v) => onConfig({ ...c, thresholds: v ? { amber: 95, red: 100 } : null })} />
            {t && (
              <>
                <RowNumber label="Amber ≥ (dB)" value={t.amber} step={1} min={0} max={140} onChange={(v) => onConfig({ ...c, thresholds: { ...t, amber: Math.round(v) } })} />
                <RowNumber label="Red ≥ (dB)" value={t.red} step={1} min={0} max={140} onChange={(v) => onConfig({ ...c, thresholds: { ...t, red: Math.round(v) } })} />
              </>
            )}
          </>
        );
      })()}
      {c.type === "record-status" && (
        <>
          <RowSelect
            label="Recorder"
            hint="Any = red whenever either OBS or REAPER is recording"
            value={c.source ?? "any"}
            options={[
              { value: "any", label: "Any recorder" },
              { value: "obs", label: "OBS only" },
              { value: "reaper", label: "REAPER only" },
            ]}
            onChange={(v) => onConfig({ ...c, source: v as "any" | "obs" | "reaper" })}
          />
          <RowText label="Recording text" value={c.recordingText ?? ""} placeholder="RECORDING" onChange={(v) => onConfig({ ...c, recordingText: v })} />
          <RowText label="Idle text" value={c.idleText ?? ""} placeholder="STANDBY" onChange={(v) => onConfig({ ...c, idleText: v })} />
          <RowText label="Offline text" value={c.offlineText ?? ""} placeholder="NO RECORDER" onChange={(v) => onConfig({ ...c, offlineText: v })} />
          <RowSwitch label="Fill red while recording" checked={c.fillWhenRecording ?? true} onChange={(v) => onConfig({ ...c, fillWhenRecording: v })} />
          <RowSwitch label="Hide when idle" hint="Pure tally light — nothing on screen unless recording" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
        </>
      )}

      {c.type === "obs-status" && (() => {
        const mode = c.mode ?? "recording";
        const liveLabel = !obs?.connected
          ? "Not connected"
          : (mode === "streaming" ? obs.streaming : mode === "virtualcam" ? obs.virtualCam : obs.recording)
            ? "Active now"
            : "Connected · idle";
        const activePlaceholder = mode === "streaming" ? "OBS: Streaming" : mode === "virtualcam" ? "OBS: Virtual Cam" : "OBS: Recording";
        const idlePlaceholder = mode === "streaming" ? "OBS: Stream off" : mode === "virtualcam" ? "OBS: Cam off" : "OBS: Standby";
        return (
          <>
            <Row label="Show">
              <Select value={mode} onValueChange={(v: string) => onConfig({ ...c, mode: v as "recording" | "streaming" | "virtualcam" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="recording">Recording</SelectItem>
                  <SelectItem value="streaming">Streaming</SelectItem>
                  <SelectItem value="virtualcam">Virtual camera</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="OBS"><span className="text-caption2 text-fg-muted">{liveLabel}</span></Row>
            <RowText label="Active text" value={c.recordingText ?? ""} placeholder={activePlaceholder} onChange={(v) => onConfig({ ...c, recordingText: v })} />
            <RowText label="Idle text" value={c.idleText ?? ""} placeholder={idlePlaceholder} onChange={(v) => onConfig({ ...c, idleText: v })} />
            <RowText label="Offline text" value={c.offlineText ?? ""} placeholder="OBS: Offline" onChange={(v) => onConfig({ ...c, offlineText: v })} />
            <RowSwitch label="Fill red when active" checked={c.fillWhenRecording ?? true} onChange={(v) => onConfig({ ...c, fillWhenRecording: v })} />
            {mode === "recording" && (
              <RowSwitch label="Show timecode" checked={c.showTimecode ?? false} onChange={(v) => onConfig({ ...c, showTimecode: v })} />
            )}
            <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
          </>
        );
      })()}
      {c.type === "reaper-status" && (() => {
        const liveLabel = !reaper?.connected
          ? "Not connected"
          : reaper.recording
            ? "Recording now"
            : "Connected · idle";
        return (
          <>
            <Row label="REAPER"><span className="text-caption2 text-fg-muted">{liveLabel}</span></Row>
            <RowText label="Recording text" value={c.recordingText ?? ""} placeholder="REAPER: Recording" onChange={(v) => onConfig({ ...c, recordingText: v })} />
            <RowText label="Idle text" value={c.idleText ?? ""} placeholder="REAPER: Standby" onChange={(v) => onConfig({ ...c, idleText: v })} />
            <RowText label="Offline text" value={c.offlineText ?? ""} placeholder="REAPER: Offline" onChange={(v) => onConfig({ ...c, offlineText: v })} />
            <RowSwitch label="Fill red when recording" checked={c.fillWhenRecording ?? true} onChange={(v) => onConfig({ ...c, fillWhenRecording: v })} />
            <RowSwitch label="Show position" checked={c.showPosition ?? false} onChange={(v) => onConfig({ ...c, showPosition: v })} />
            <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
          </>
        );
      })()}
      {c.type === "countdown-timer" && (
        <>
          <RowSwitch label="Amber warning" checked={c.warnSeconds != null} onChange={(v) => onConfig({ ...c, warnSeconds: v ? 60 : undefined })} />
          {c.warnSeconds != null && (
            <RowNumber label="Warn at (s)" value={c.warnSeconds} step={5} min={0} max={3600} onChange={(v) => onConfig({ ...c, warnSeconds: Math.round(v) })} />
          )}
          <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => onConfig({ ...c, hideWhenIdle: v })} />
        </>
      )}
      {c.type === "rosstalk-button" && (() => {
        const target = rosstalkTargets.find((t) => t.id === c.targetId) ?? null;
        const family = target?.config.family ?? "carbonite";
        // Only ever offer commands for THIS target's family — a Carbonite XPT sent
        // to an Ultrix is a different command entirely.
        const commands = rosstalkCommands.filter((cmd) => cmd.family === family);
        const command = commands.find((cmd) => cmd.id === c.commandId) ?? null;
        return (
          <>
            <RowSelect
              label="Target"
              value={c.targetId ?? ""}
              options={[
                { value: "", label: "Pick a target…" },
                ...rosstalkTargets.map((t) => ({
                  value: t.id,
                  label: `${t.name} (${t.config.family ?? "carbonite"})`,
                })),
              ]}
              onChange={(v) => onConfig({ ...c, targetId: v || null, commandId: null, params: {} })}
            />
            <RowSelect
              label="Command"
              hint={target ? undefined : "Pick a target first"}
              value={c.commandId ?? ""}
              options={[
                { value: "", label: "Pick a command…" },
                ...commands.map((cmd) => ({ value: cmd.id, label: cmd.label })),
              ]}
              onChange={(v) => onConfig({ ...c, commandId: v || null, params: {} })}
            />
            {command?.params.map((p) =>
              p.type === "number" ? (
                <RowNumber
                  key={p.key}
                  label={p.label}
                  hint={p.help}
                  value={Number(c.params[p.key] ?? p.min ?? 0)}
                  min={p.min}
                  max={p.max}
                  onChange={(n) => onConfig({ ...c, params: { ...c.params, [p.key]: n } })}
                />
              ) : p.type === "enum" ? (
                <RowSelect
                  key={p.key}
                  label={p.label}
                  hint={p.help}
                  value={String(c.params[p.key] ?? "")}
                  options={(p.options ?? []).map((o) => ({ value: o, label: o }))}
                  onChange={(v) => onConfig({ ...c, params: { ...c.params, [p.key]: v } })}
                />
              ) : (
                <RowText
                  key={p.key}
                  label={p.label}
                  hint={p.help}
                  value={String(c.params[p.key] ?? "")}
                  onChange={(v) => onConfig({ ...c, params: { ...c.params, [p.key]: v } })}
                />
              ),
            )}
            <RowText label="Label" value={c.label} onChange={(v) => onConfig({ ...c, label: v })} />
          </>
        );
      })()}

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
            <Row label="Target" hint="The OSC device this button sends to — mixer, lighting board, etc. Set these up under Integrations → OSC.">
              <Select value={c.targetId ?? ""} onValueChange={(v: string) => onConfig({ ...c, targetId: v || null })}>
                <SelectTrigger><SelectValue placeholder={oscTargets.length ? "Select target" : "No OSC targets"} /></SelectTrigger>
                <SelectContent>
                  {oscTargets.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Row>
            <RowText label="Label" value={c.label ?? ""} placeholder="Button" onChange={(v) => onConfig({ ...c, label: v })} />
            <RowText label="Address" hint="The OSC path to send when tapped, e.g. /ch/01/mix/on — copy it from your device's OSC documentation. No spaces." value={c.address} placeholder="/ch/01/mix/on" onChange={(v) => onConfig({ ...c, address: v })} />
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">
                Arguments
                <InfoHint>
                  Values sent with the OSC message, in order. Pick each type — int (whole number), float
                  (decimal), string (text), or true/false (booleans, no value needed). Many on/off commands
                  need one int of 1 or 0; leave empty if your command takes none.
                </InfoHint>
              </span>
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
                    <Input value={String(a.value ?? "")} onChange={(e) => setArg(i, { value: e.target.value })} placeholder="value" className="flex-1 min-w-0 text-fg" />
                  )}
                  <Button variant="transparent" size="small" iconOnly onClick={() => onConfig({ ...c, args: args.filter((_, idx) => idx !== i) })} aria-label="Remove argument"><Trash2Icon className="size-3.5 text-fg-muted" /></Button>
                </div>
              ))}
              <Button variant="transparent" size="small" className="self-start" onClick={() => onConfig({ ...c, args: [...args, { type: "i", value: "1" }] })}>Add argument</Button>
            </div>
            <RowSwitch label="Feedback" hint="Reflect the device's state on the button: watch a return OSC address and recolor the button when its value matches (e.g. light up when the channel is live)." checked={!!fb} onChange={(v) => onConfig({ ...c, feedback: v ? { address: c.address || "/", equals: 1 } : null })} />
            {fb && (
              <>
                <RowText label="Watch address" value={fb.address} placeholder="/ch/01/mix/on" onChange={(v) => onConfig({ ...c, feedback: { ...fb, address: v } })} />
                <RowText label="Active when =" value={String(fb.equals ?? "")} placeholder="1 (blank = any truthy)" onChange={(v) => onConfig({ ...c, feedback: { ...fb, equals: v } })} />
                <RowText label="Active color" value={fb.activeColor ?? ""} placeholder="var(--red-9)" onChange={(v) => onConfig({ ...c, feedback: { ...fb, activeColor: v } })} />
              </>
            )}
          </>
        );
      })()}
      {c.type === "people-counter" && (() => {
        const zones = peopleCount?.zones ?? [];
        const metric = c.metric ?? "attendance";
        const perZone = metric === "attendance" || metric === "occupancy";
        const labelHint: Record<string, string> = { attendance: "people", occupancy: "in room", peak: "peak", min: "low", avg: "average" };
        return (
          <>
            <Row label="Count">
              <Select
                value={metric}
                onValueChange={(v: string) => {
                  const m = v as NonNullable<typeof c.metric>;
                  // peak/min/avg are building-wide only — drop any zone selection.
                  onConfig({ ...c, metric: m, zoneId: m === "attendance" || m === "occupancy" ? c.zoneId : null });
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="occupancy">In room (now)</SelectItem>
                  <SelectItem value="peak">Peak attendance (today)</SelectItem>
                  <SelectItem value="min">Lowest attendance (today)</SelectItem>
                  <SelectItem value="avg">Avg attendance (today)</SelectItem>
                  <SelectItem value="servicePeak">Peak in room (this service)</SelectItem>
                  <SelectItem value="servicePeakAttendance">Peak attendance (this service)</SelectItem>
                  <SelectItem value="serviceAttendance">Total entries (this service)</SelectItem>
                  <SelectItem value="attendance">Total entries (day)</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            {perZone ? (
              <Row label="Zone">
                <Select value={c.zoneId ?? ""} onValueChange={(v: string) => onConfig({ ...c, zoneId: v || null })}>
                  <SelectTrigger><SelectValue placeholder={zones.length ? "Building total" : "No zones detected"} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Building total</SelectItem>
                    {zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>
            ) : (
              <p className="text-caption2 text-fg-muted leading-snug">Peak, low and average are building-wide (today), from the occupancy sensor.</p>
            )}
            <RowSwitch label="Show label" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
            {(c.showLabel ?? true) && (
              <RowText label="Label" value={c.label ?? ""} placeholder={labelHint[metric]} onChange={(v) => onConfig({ ...c, label: v })} />
            )}
          </>
        );
      })()}
      {c.type === "people-graph" && <PeopleGraphInspector c={c} onConfig={onConfig} />}
      {c.type === "people-panel" && (() => {
        const ORDER = ["occupancy", "servicePeak", "peak", "servicePeakAttendance", "serviceAttendance", "attendance", "capacity", "avg", "avgService", "vsAverage", "min"] as const;
        const LABEL: Record<string, string> = { occupancy: "In room", peak: "Peak att.", servicePeak: "Peak in room (svc)", servicePeakAttendance: "Peak att. (svc)", serviceAttendance: "Entries (svc)", attendance: "Entries (day)", capacity: "% capacity", avg: "Avg att.", avgService: "Avg / service", vsAverage: "vs average", min: "Lowest att." };
        const HINT: Record<string, string> = {
          occupancy: "People currently in the room right now (entries minus exits).",
          peak: "Peak attendance — the highest number of people in the room today.",
          servicePeak: "Highest number in the room during THIS service — resets each service, unlike the day-wide peak.",
          servicePeakAttendance: "Highest cumulative entries during THIS service — resets each service.",
          serviceAttendance: "Total entries THIS service — cumulative door count (double-counts re-entries), reset per service.",
          attendance: "Total entries today across ALL services — cumulative door count, double-counts re-entries.",
          capacity: "In-room now as a percentage of the configured building capacity.",
          avg: "Average attendance (in-room) across today.",
          avgService: "Average peak attendance across your past recorded services (a typical-service baseline).",
          vsAverage: "How this service's peak attendance compares to your typical service.",
          min: "Lowest attendance (in-room) during the current or most-recent live service — the 'floor'.",
        };
        const cur = c.metrics ?? ["occupancy", "peak", "attendance"];
        const toggle = (k: (typeof ORDER)[number], on: boolean) => {
          const set = new Set<string>(cur);
          if (on) set.add(k);
          else set.delete(k);
          onConfig({ ...c, metrics: ORDER.filter((x) => set.has(x)) });
        };
        return (
          <>
            <p className="text-caption2 text-fg-muted leading-snug">Building-wide people metrics, shown side by side. Toggle each:</p>
            {ORDER.map((k) => (
              <RowSwitch key={k} label={LABEL[k]} hint={HINT[k]} checked={cur.includes(k)} onChange={(v) => toggle(k, v)} />
            ))}
            <RowToggle
              label="Layout"
              value={c.orientation ?? "row"}
              options={[{ value: "row", label: "Row" }, { value: "column", label: "Stacked" }]}
              onChange={(v) => onConfig({ ...c, orientation: v as "row" | "column" })}
            />
            <RowSwitch label="Show labels" checked={c.showLabels ?? true} onChange={(v) => onConfig({ ...c, showLabels: v })} />
          </>
        );
      })()}
      {c.type === "baptism-timer" && (
        <>
          <Row label="Show">
            <Select value={c.field ?? "live"} onValueChange={(v: string) => onConfig({ ...c, field: v as NonNullable<typeof c.field> })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="live">Live (running clock)</SelectItem>
                <SelectItem value="count">Count baptized</SelectItem>
                <SelectItem value="total">Total time</SelectItem>
                <SelectItem value="average">Average per person</SelectItem>
                <SelectItem value="last">Last person</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          <RowSwitch label="Show label" checked={c.showLabel ?? true} onChange={(v) => onConfig({ ...c, showLabel: v })} />
          {(c.showLabel ?? true) && (
            <RowText label="Label" value={c.label ?? ""} placeholder="(auto)" onChange={(v) => onConfig({ ...c, label: v })} />
          )}
          <p className="text-caption2 text-fg-muted leading-snug">Driven by the Baptisms tab. &ldquo;Live&rdquo; ticks the current testimony/baptism; others summarize the session.</p>
        </>
      )}
      {c.type === "image" && (
        <ImageConfig src={c.src} onChange={(v) => onConfig({ type: "image", src: v })} />
      )}
      {c.type === "plan-attachment" && (
        <PlanAttachmentConfig c={c} onConfig={onConfig} o={o} canvas={canvas} onGeom={onGeom} />
      )}
      {c.type === "shape" && (
        <RowToggle
          label="Shape"
          value={c.shape}
          options={[{ value: "rect", label: "Rect" }, { value: "ellipse", label: "Ellipse" }]}
          onChange={(v) => onConfig({ type: "shape", shape: v })}
        />
      )}
      {c.type === "brand-logo" && (
        <RowSwitch label="Empty logo" checked={c.useEmptySlotLogo ?? false} onChange={(v) => onConfig({ type: "brand-logo", useEmptySlotLogo: v })} />
      )}
      {isStylingOnly(c.type) && (
        <p className="text-caption2 text-fg-muted leading-snug">Updates automatically — no options. Use the styling controls below.</p>
      )}
      {/* An object this build cannot render — almost always a layout restored from
          a NEWER version. Say so plainly and leave it alone: it renders as nothing
          on the display, and deleting it here would throw away work that the
          version it came from can still use. */}
      {!isKnownObjectType(c.type) && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-a5 bg-amber-a2 p-3">
          <span className="text-caption1 text-fg">This version can&apos;t show this object</span>
          <span className="text-caption2 text-fg-muted">
            The layout asks for <code>{c.type}</code>, which this build does not have — usually
            because the layout was saved by a newer version and restored here. It stays in the
            layout and renders as nothing; update this server and it will come back.
          </span>
          <span className="text-caption2 text-fg-muted">
            Leave it in place unless you are sure: deleting it here removes it for the newer
            version too.
          </span>
        </div>
      )}

      <Separator />

      {/* Style preset — one dropdown of complete "looks" (surface + optional tint).
          Applies the shared style fields below; fine-tune with Fill / Border / Elevation. */}
      <Row label="Style" hint="Apply a preset look — surface (Flat/Glass/Elevated/Solid/Outline) with an optional color tint. Fine-tune with Fill, Border, and Elevation below.">
        <Select value={matchStylePreset(s)} onValueChange={(v: string) => { const p = STYLE_PRESETS.find((x) => x.value === v); if (p) onStyle(p.style); }}>
          <SelectTrigger><SelectValue placeholder="Apply a look…" /></SelectTrigger>
          <SelectContent>
            {STYLE_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Row>

      {/* Style */}
      {isText && (
        <>
          <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted mt-1">Type</span>
          {/* Fall back to THIS type's own default, not a blanket 0.05. An object
              whose default differs (an embedded view starts at 0.016) otherwise
              reported a size it was not rendering at, so the first nudge of the
              stepper jumped it to a number it had never been. */}
          <Row label="Font size"><NumberField value={pxOf(s.fontSize, defaultStyle(c.type).fontSize ?? 0.05)} step={1} min={1} max={Math.round(0.5 * canvas.height)} suffix="px" onChange={(px) => onStyle({ fontSize: px / canvas.height })} /></Row>
          <Row label="Weight">
            <Select value={String(s.fontWeight ?? 400)} onValueChange={(v: string) => onStyle({ fontWeight: parseInt(v, 10) })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{WEIGHTS.map((w) => <SelectItem key={w} value={String(w)}>{w}</SelectItem>)}</SelectContent>
            </Select>
          </Row>
          <Row label="Color"><input type="color" value={hexForInput(s.color, "#ffffff")} onChange={(e) => onStyle({ color: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-line bg-transparent" /></Row>
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
      <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted mt-1">Fill</span>
      <Row label="Fill"><input type="color" value={hexForInput(s.background, "#000000")} onChange={(e) => onStyle({ background: e.target.value })} className="w-9 h-7 rounded cursor-pointer border border-line bg-transparent" />
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
          className="flex-1 min-w-0 accent-accent"
          aria-label="Opacity"
        />
        <span className="w-9 shrink-0 text-right tabular-nums text-caption2 text-fg">{Math.round((s.opacity ?? 1) * 100)}%</span>
      </Row>
      <Row label="Radius"><NumberField value={pxOf(s.cornerRadius, 0)} step={1} min={0} max={Math.round(0.5 * canvas.height)} suffix="px" onChange={(px) => onStyle({ cornerRadius: px / canvas.height })} /></Row>
      <Row label="Padding"><NumberField value={pxOf(s.padding, 0)} step={1} min={0} max={Math.round(0.3 * canvas.height)} suffix="px" onChange={(px) => onStyle({ padding: px / canvas.height })} /></Row>
      <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted mt-1">Border</span>
      <Row label="Border">
        <input
          type="color"
          value={hexForInput(s.borderColor, "#ffffff")}
          onChange={(e) => onStyle({ borderColor: e.target.value, borderWidth: s.borderWidth ?? 0 })}
          className="w-9 h-7 rounded cursor-pointer border border-line bg-transparent"
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
      <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-muted mt-1">Elevation</span>
      {/* Elevation: one slider with labeled None/Low/Med/High stops (ticks), fine
          values allowed in between. Drives the box's drop shadow for layered depth. */}
      <Row label="Elevation" hint="Soft drop shadow under this object's box — lifts it above whatever it overlaps. Snaps toward None/Low/Med/High; drag for in-between.">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={s.boxShadow ?? 0}
          onChange={(e) => onStyle({ boxShadow: parseFloat(e.target.value) })}
          list="elevation-stops"
          className="flex-1 min-w-0 accent-accent"
          aria-label="Elevation"
        />
        <datalist id="elevation-stops">
          <option value="0" />
          <option value="0.35" />
          <option value="0.65" />
          <option value="1" />
        </datalist>
        <span className="w-10 shrink-0 text-caption2 text-fg-muted text-right tabular-nums">{elevationLabel(s.boxShadow ?? 0)}</span>
      </Row>

      <Separator />

      {/* Align within the parent (canvas for top-level, container box if nested) */}
      <Row label="Align">
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 0 })} aria-label="Align left" tooltip="Align left"><AlignStartVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: (1 - o.w) / 2 })} aria-label="Center horizontally" tooltip="Center horizontally"><AlignCenterVertical className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ x: 1 - o.w })} aria-label="Align right" tooltip="Align right"><AlignEndVertical className="size-3.5" /></Button>
        </ButtonGroup>
        <ButtonGroup>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 0 })} aria-label="Align top" tooltip="Align top"><AlignStartHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: (1 - o.h) / 2 })} aria-label="Center vertically" tooltip="Center vertically"><AlignCenterHorizontal className="size-3.5" /></Button>
          <Button variant="filled" size="small" iconOnly onClick={() => onGeom({ y: 1 - o.h })} aria-label="Align bottom" tooltip="Align bottom"><AlignEndHorizontal className="size-3.5" /></Button>
        </ButtonGroup>
      </Row>

      {/* Position & size in design-px of the parent box (canvas for top-level) */}
      <span className="text-caption2 text-fg-muted">
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
