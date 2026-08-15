import { useState, useEffect, useRef, useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { ContextMenu, type ContextMenuItem } from "../components/ui/context-menu";
import {
  UndoIcon,
  Trash2Icon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  
  ChevronDownIcon,
  
  
  Grid3x3Icon,
  AlignHorizontalDistributeCenterIcon,
  MonitorSmartphoneIcon,
  SaveIcon,
  DownloadIcon,
  
  
  
  
  
  
  PencilIcon,
  CheckIcon,
  LayoutTemplateIcon,
  CornerLeftUpIcon,
  LockIcon,
  UnlockIcon,
  
  FilterIcon,
  FilePlusIcon,
} from "lucide-react";
import { DropdownMenu, Popover } from "radix-ui";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectValue,
  ButtonGroup,
  
  Separator,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  
  UnsavedBanner,
} from "../components/ui";
import { ObjectContent, boxStyle, useLayoutData, type LayoutRenderCtx } from "../main/layout-renderer";
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
} from "../main/layout-tree";
import {
  GRID,
  HANDLES,
  
  applyResize,
  clamp,
  gridUnits,
  handleCursor,
  
  snapRectToGrid,
  snapTo,
  type Handle,
} from "../settings/sections/layout-geometry.js";
import { } from "../main/use-spl-state";
import { } from "../main/use-wireless-channels";
import { } from "../main/use-people-count-state";
import { } from "../main/use-obs-state";
import { } from "../main/use-reaper-state";
import { } from "../main/use-osc-state";
import { } from "../main/use-stage-state";
import { } from "../main/use-plan-items";
import { } from "../main/use-dashboard-state";
import { useConfiguredIntegrations, } from "../main/use-integration-states";
import {
  
  
  
  
  PALETTE_GROUPS,
  defaultConfig,
  defaultStyle,
  
  objectIntegration,
  typeLabel,
  
} from "../main/layout-objects";
import { invoke } from "../lib/api";
import { fitFor } from "../main/console-fit";
import { viewSurface } from "@main/types/views";
import { alignRect, type Guide } from "./alignment";
import { ShapePreview, PREVIEW_SHAPES, type PreviewShape } from "./preview-shape";
import { AlignmentGuides } from "./alignment-guides";

/** How close an edge must come before it snaps, in rendered pixels. Small enough
 *  that deliberate placement is never fought, large enough to catch a hand. */
const ALIGN_TOLERANCE_PX = 8;
import { uid, dashboardTemplate, confidenceMonitorTemplate, CANVAS_PRESETS } from "./layout-templates";
import { Inspector } from "./inspector";
import {
  
  NumberField, 
} from "./inspector-rows";
export { dashboardTemplate, confidenceMonitorTemplate };
import { InlineSlotsEditor } from "../settings/sections/inline-slots-editor";

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
  /** Absolute canvas rects of everything the dragged object may align to,
   *  snapshotted at drag start. Excludes the dragged object, its own subtree
   *  (an object cannot line up with its own child) and, in a group move, the
   *  rest of the group — which is moving with it and would drag the guides along. */
  siblings: FracRect[];
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
  effectiveFit,
  canvas, objects, selectedId, selectedIds, gridOn, alignOn, ctx, ndiSource, interactive,
  onSelect, onMarqueeSelect, onGeom, onGeomMany, onCommitStart, onReparent, onBoxSize,
  onContextMenu,
}: {
  /** What the layout will actually do — a console with no explicit fit is
   *  responsive. Passed in so the canvas and the toolbar cannot disagree. */
  effectiveFit: "contain" | "responsive";
  canvas: LayoutCanvas;
  objects: LayoutObject[];
  selectedId: string | null;
  selectedIds: Set<string>;
  gridOn: boolean;
  /** Snap to the other objects' edges, centres and spacing. Independent of the
   *  grid: both can be on, and grid runs first so alignment only refines. */
  alignOn: boolean;
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
  const fill = effectiveFit === "responsive";
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
  // Guides for the CURRENT drag only. Mirrored into a ref so the move handler can
  // check "are any drawn?" without listing guides as an effect dependency, which
  // would rebind the window listeners on every frame of a drag.
  const [guides, setGuidesState] = useState<Guide[]>([]);
  const guidesRef = useRef<Guide[]>([]);
  const setGuides = useCallback((g: Guide[]) => {
    guidesRef.current = g;
    setGuidesState(g);
  }, []);

  // Window-level move/up while dragging.
  useEffect(() => {
    if (!drag || boxW <= 0) return;
    // Deltas are fractions of the dragged object's PARENT box. Snapping is done in
    // ABSOLUTE canvas space (snapRectToGrid), so objects nested in a container land
    // on the same visible grid as top-level ones.
    const onMove = (e: globalThis.PointerEvent) => {
      const dx = (e.clientX - drag.px) / drag.parentW;
      const dy = (e.clientY - drag.py) / drag.parentH;
      // Alt is the escape hatch from every kind of snapping. Read live from the
      // event rather than captured at drag start, so it can be pressed and
      // released mid-drag.
      const free = e.altKey;
      let geom: Pick<LayoutObject, "x" | "y" | "w" | "h">;
      if (drag.mode === "move") {
        const local = { x: drag.start.x + dx, y: drag.start.y + dy, w: drag.start.w, h: drag.start.h };
        const snapped = gridOn && !free ? snapRectToGrid(local, drag.parentAbs, boxW, boxH, false) : local;
        geom = { x: clamp(snapped.x, 0, 1 - drag.start.w), y: clamp(snapped.y, 0, 1 - drag.start.h), w: drag.start.w, h: drag.start.h };
      } else {
        const g = applyResize(drag.start, drag.mode, dx, dy);
        geom = gridOn && !free ? snapRectToGrid(g, drag.parentAbs, boxW, boxH, true) : g;
      }

      // Alignment runs AFTER the grid and in absolute canvas space, so a nested
      // object lines up with the lines actually drawn rather than with a grid
      // relative to its own parent. A group move is excluded: the group has no
      // single edge to align, and snapping the primary would shear the others.
      if (alignOn && !free && !drag.group) {
        const abs = composeRect(drag.parentAbs, geom);
        const { rect, guides } = alignRect(
          abs,
          drag.siblings,
          { w: boxW, h: boxH },
          ALIGN_TOLERANCE_PX,
          drag.mode === "move" ? null : drag.mode,
        );
        const back = localizeRect(drag.parentAbs, rect);
        geom = {
          x: clamp(back.x, 0, 1 - back.w),
          y: clamp(back.y, 0, 1 - back.h),
          w: back.w,
          h: back.h,
        };
        setGuides(guides);
      } else if (guidesRef.current.length) {
        setGuides([]);
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
      setGuides([]);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // A drag that ends by unmount (route change, undo, the object deleted from
      // under it) never reaches onUp, and a stale guide would hang on the canvas
      // with nothing dragging.
      setGuides([]);
    };
  }, [drag, boxW, boxH, gridOn, alignOn, canvas, onGeom, onGeomMany, onReparent, setGuides]);

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
    // Alignment targets, in the same walk. Hidden objects are skipped: an
    // invisible thing must not pull a visible one, and the operator would have
    // no way to see why it jumped.
    const movingIds = new Set(excluded);
    group?.forEach((g) => movingIds.add(g.id));
    const siblings: FracRect[] = [];
    forEachWithRect(objects, (n) => {
      if (!movingIds.has(n.o.id) && !n.o.hidden) siblings.push(n.abs);
    });
    setDrag({
      id: o.id, mode, start: o, px: e.clientX, py: e.clientY,
      parentW: parentAbs.w * boxW, parentH: parentAbs.h * boxH,
      parentAbs, depth, canReparent: depth === 0, targets, siblings, group,
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
              {/* Alignment guides. In the overlay, which shares the grid and
                  content layers' explicit box, so a guide sits exactly on the
                  edge it claims to mark. */}
              <AlignmentGuides guides={guides} />
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

export function LayoutEditor({
  view,
  slotsViews,
  templates,
  onSave,
  onSaveTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
  startEditing = false,
}: {
  view: View;
  slotsViews: View[];
  templates: LayoutTemplate[];
  onSave: (layout: LayoutDTO) => Promise<void>;
  onSaveTemplate: (name: string, layout: LayoutDTO) => Promise<void>;
  onUpdateTemplate: (id: string, patch: { name?: string; layout?: LayoutDTO }) => Promise<void>;
  /** Open straight into editing, for callers that arrived to edit. */
  startEditing?: boolean;
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
  // The effective fit, not just the stored one: a console with nothing set is
  // responsive, and a toolbar showing "Letterbox" selected would tell the
  // operator the opposite of what they see.
  const effectiveFit = fitFor(view, canvas.fit);
  const [gridOn, setGridOn] = useState(true);
  // On by default: lining an object up with its neighbours is the common case,
  // and Alt suppresses it for the drag where it is not.
  const [alignOn, setAlignOn] = useState(true);
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
  // Starts in preview unless the caller arrived specifically to edit. Reaching
  // this from a screen's "Edit layout" and then having to press "Edit layout"
  // again is the same button twice for one intent.
  const [isEditing, setIsEditing] = useState(startEditing);
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
  // Which shape the canvas cell is showing. Design is the editor; the others are
  // read-only renders of another viewport (see preview-shape.tsx).
  const [previewShape, setPreviewShape] = useState<PreviewShape>(PREVIEW_SHAPES[0]);
  // The cell's own rendered size, so a preview can scale itself to fit. Measured
  // rather than derived: at a non-design shape the cell's height comes from the
  // DESIGN aspect, which tells a phone preview nothing about the room it has.
  const [previewAvail, setPreviewAvail] = useState({ w: 0, h: 0 });
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
      setPreviewAvail({ w: width, h: Math.round(Math.min(fit, cap)) });
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
  /**
   * Put an object's look back to the default for its type.
   *
   * REPLACES the style rather than patching it — every other style edit is a
   * merge, and a merge cannot clear a field, so "reset" via onStyle would leave
   * behind exactly the hand-tuning it was meant to undo.
   *
   * Style only. Geometry, configuration and the responsive settings are the
   * operator's separate decisions and are not this button's business.
   */
  function resetLook(id: string) {
    setObjects((prev) => mapById(prev, id, (o) => ({ ...o, style: defaultStyle(o.config.type) })));
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
        <Button
          variant={alignOn ? "accent" : "filled"}
          size="small"
          onClick={() => setAlignOn((v) => !v)}
          aria-label="Toggle align to objects"
          aria-pressed={alignOn}
          tooltip="Snap to other objects' edges, centres and spacing. Hold Alt while dragging to place freely."
        >
          <AlignHorizontalDistributeCenterIcon className="size-3.5" /> Align
        </Button>
        {/* Shape preview. Only Design is editable; the rest render the same
            LayoutRenderer the kiosk mounts, read-only, at that viewport. */}
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              variant={previewShape.vp ? "accent" : "filled"}
              size="small"
              tooltip="See this layout on a window of a different shape"
            >
              <MonitorSmartphoneIcon className="size-3.5" />
              {previewShape.label}
              <ChevronDownIcon className="size-3.5 text-fg-muted" />
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content sideOffset={6} className="z-50 rounded-lg border border-line bg-popover p-1 shadow-lg">
              <div className="flex flex-col">
                {PREVIEW_SHAPES.map((s) => (
                  <Button
                    key={s.id}
                    variant={previewShape.id === s.id ? "accent" : "transparent"}
                    size="small"
                    className="justify-start"
                    onClick={() => setPreviewShape(s)}
                  >
                    {s.label}
                    {s.vp ? (
                      <span className="ml-2 text-caption2 text-fg-subtle tabular-nums">
                        {s.vp.w}&times;{s.vp.h}
                      </span>
                    ) : (
                      <span className="ml-2 text-caption2 text-fg-subtle">editable</span>
                    )}
                  </Button>
                ))}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
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
                  {/* Letterbox or Responsive. "Fill" was the old name for the
                      right-hand option and only reflowed proportionally; it is
                      still accepted from a stored layout and reads as
                      Responsive, so an old file selects the right button. */}
                  <Button
                    variant={effectiveFit === "contain" ? "accent" : "filled"}
                    size="small"
                    onClick={() => { setCanvas({ ...canvas, fit: "contain" }); setDirty(true); }}
                    tooltip="Letterbox: keep the design's shape exactly, with bars on a screen of a different shape. Right for a wall screen."
                  >
                    Letterbox
                  </Button>
                  <Button
                    variant={effectiveFit === "responsive" ? "accent" : "filled"}
                    size="small"
                    onClick={() => { setCanvas({ ...canvas, fit: "responsive" }); setDirty(true); }}
                    tooltip="Responsive: use the whole window. Objects hold their anchors, keep their shape where asked, and stack into a column when the window is a very different shape."
                  >
                    Responsive
                  </Button>
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
          {previewShape.vp ? (
            // The live edit state, not the saved view: the point is to check the
            // change you just made against another shape before saving it.
            <ShapePreview
              shape={previewShape}
              layout={{ version: 1, canvas, objects }}
              ndiSource={view.ndiSource ?? null}
              surface={viewSurface(view)}
              avail={previewAvail}
            />
          ) : data.state ? (
            <EditorCanvas
              effectiveFit={effectiveFit}
              canvas={canvas}
              objects={objects}
              selectedId={selectedId}
              selectedIds={selectedIds}
              alignOn={alignOn}
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
                onResetLook={withHistory(() => resetLook(selected.id))}
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
