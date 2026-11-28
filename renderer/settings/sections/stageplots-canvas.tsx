// stageplots-canvas.tsx — the editor's canvas: the plot, drawn by PlotSvg, with
// pointer and keyboard editing on top of PR 1's pan and zoom.
//
// A press on an item selects it and starts a drag; on its corner square, a
// resize; on its top circle, a rotate; on a cable's point, that point. A press
// on the empty plot clears the selection and pans. The hit is decided on
// pointerdown, because once the SVG captures the pointer every later event
// names the SVG, not the item. The editor claims the item's pointer from
// usePanZoom so the drag does not also pan; a second finger arriving ends the
// drag and pinches instead. Pointer events throughout, so mouse, pen and touch
// behave alike.
//
// Arrow keys nudge (Shift for further) and Delete or Backspace removes, only
// while the canvas has focus; a press on it focuses it. So do Cmd/Ctrl with C, X,
// V and D (copy, cut, paste, duplicate) and with ] and [ (forward and backward a
// step; add Alt for all the way: Shift+Cmd+[ and ] switch browser tabs on macOS and
// never reach the page). Undo and redo keys are the page's (stageplots-edit.tsx).
//
// A right-click, or a long press on touch, opens the app's context menu: on an
// item (selecting it first) Cut, Copy, Paste, Duplicate, Arrange and Delete; on
// the empty plot Paste here, Add here, Undo, Redo and Fit. A long press is
// cancelled the moment a drag of an item starts; a pan moves past its own slop.
//
// What jsdom cannot show: real pointer capture, the SVG's measured box, pinch.
// The tests stub the box; the rest is driven in a browser.

import { useRef, type KeyboardEvent, type PointerEvent, type RefObject, type SVGProps } from "react";

import type { BackgroundView, PlotItem } from "@main/types/stageplots";

import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { useContextMenuState, useContextMenuTrigger } from "../../components/ui/context-menu-trigger";
import { useLatestRef } from "../../lib/use-latest-ref";
import { uid } from "../../lib/uid";
import { canPaste, copyItems, takePaste } from "../../main/stageplots/clipboard";
import { HANDLE_PAD } from "../../main/stageplots/plot-items";
import { PlotSvg } from "../../main/stageplots/plot-svg";
import type { AddKind, Arrange, EditorAction } from "../../main/stageplots/editor-state";
import { ROTATE_STEP, ROTATE_STEP_SHIFT, angleTo, round1 } from "../../main/stageplots/geometry";
import { PALETTE } from "./stageplots-palette";
import type { PanZoom } from "../../main/stageplots/use-pan-zoom";
import { isMod } from "../../lib/keyboard-target";

/** Arrow keys move this far, in plot units, and Shift with them this far. */
export const NUDGE = 4;
export const NUDGE_FAR = 20;
/** How far, in screen pixels, a press moves before it is a drag and not a click. */
const DRAG_SLOP_PX = 2;

type Drag =
  | {
      mode: "move" | "size" | "rot";
      id: string;
      pointerId: number;
      start: { x: number; y: number };
      startPx: { x: number; y: number };
      moved: boolean;
      /** A rotate handle drawn under the item (no room above): its drag turns the other way round. */
      below?: boolean;
    }
  | { mode: "pt"; id: string; index: number; pointerId: number; start: { x: number; y: number }; startPx: { x: number; y: number }; moved: boolean };

/** A screen point as plot units under the current view, with plot units per pixel; null before layout. */
export function toPlot(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number; k: number } | null {
  const r = svg.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const [vx, vy, vw, vh] = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  if (![vx, vy, vw, vh].every(Number.isFinite)) return null;
  return { x: vx + ((clientX - r.left) * vw) / r.width, y: vy + ((clientY - r.top) * vh) / r.height, k: vw / r.width };
}

export interface CanvasProps {
  name: string;
  items: PlotItem[];
  selectedId: string | null;
  background: BackgroundView | null;
  fade: number;
  pz: PanZoom;
  svgRef: RefObject<SVGSVGElement | null>;
  dispatch: (action: EditorAction) => void;
  /** Whether the draft has a step to undo, and to redo: the empty plot's menu offers them. */
  canUndo?: boolean;
  canRedo?: boolean;
}

/** The keys Arrange answers to, with Cmd or Ctrl held: ] forward, [ backward, Alt for all the way. */
const ARRANGE_KEYS: Record<string, [Arrange, Arrange]> = { BracketRight: ["forward", "front"], BracketLeft: ["backward", "back"] };

export function StagePlotsCanvas({ name, items, selectedId, background, fade, pz, svgRef, dispatch, canUndo = false, canRedo = false }: CanvasProps) {
  const drag = useRef<Drag | null>(null);
  const itemsRef = useLatestRef(items);
  const { menu, open: showMenu, close: closeMenu } = useContextMenuState();

  const item = (id: string) => itemsRef.current.find((x) => x.id === id);
  const copy = (id: string, cut = false) => {
    const it = item(id);
    if (!it) return;
    copyItems([it], { cut });
    if (cut) dispatch({ type: "remove", id });
  };
  /** Paste centred on a plot point, or (no point) a step down and right of where it was copied. */
  const paste = (at?: { x: number; y: number }) => {
    const clip = takePaste();
    if (!clip) return;
    dispatch(at ? { type: "paste", items: clip.items, at } : { type: "paste", items: clip.items, dx: clip.offset, dy: clip.offset });
  };
  const duplicate = (id: string) => dispatch({ type: "duplicate", id, newId: uid("i") });

  const itemMenu = (id: string): ContextMenuItem[] => [
    { label: "Cut", shortcut: "⌘X", onSelect: () => copy(id, true) },
    { label: "Copy", shortcut: "⌘C", onSelect: () => copy(id) },
    { label: "Paste", shortcut: "⌘V", disabled: !canPaste(), onSelect: () => paste() },
    { label: "Duplicate", shortcut: "⌘D", onSelect: () => duplicate(id) },
    { separator: true },
    {
      label: "Arrange",
      items: [
        { label: "Bring to front", shortcut: "⌥⌘]", onSelect: () => dispatch({ type: "arrange", id, to: "front" }) },
        { label: "Bring forward", shortcut: "⌘]", onSelect: () => dispatch({ type: "arrange", id, to: "forward" }) },
        { label: "Send backward", shortcut: "⌘[", onSelect: () => dispatch({ type: "arrange", id, to: "backward" }) },
        { label: "Send to back", shortcut: "⌥⌘[", onSelect: () => dispatch({ type: "arrange", id, to: "back" }) },
      ],
    },
    { separator: true },
    { label: "Delete", shortcut: "⌫", danger: true, onSelect: () => dispatch({ type: "remove", id }) },
  ];
  const addHere = (kind: AddKind, at: { x: number; y: number }) => dispatch({ type: "add", kind, at: { x: round1(at.x), y: round1(at.y) }, id: uid("i") });
  const canvasMenu = (at: { x: number; y: number }): ContextMenuItem[] => {
    const [shapes, text, symbols] = PALETTE;
    const entry = (e: { kind: AddKind; name: string }): ContextMenuItem => ({ label: e.name, onSelect: () => addHere(e.kind, at) });
    return [
      { label: "Paste here", shortcut: "⌘V", disabled: !canPaste(), onSelect: () => paste(at) },
      {
        label: "Add here",
        items: [
          { heading: true, label: shapes.group },
          ...shapes.entries.map(entry),
          { heading: true, label: text.group },
          ...text.entries.map(entry),
          { label: symbols.group, items: symbols.entries.map(entry) },
        ],
      },
      { separator: true },
      { label: "Undo", shortcut: "⌘Z", disabled: !canUndo, onSelect: () => dispatch({ type: "undo" }) },
      { label: "Redo", shortcut: "⇧⌘Z", disabled: !canRedo, onSelect: () => dispatch({ type: "redo" }) },
      { label: "Fit the whole plot", onSelect: pz.fit },
    ];
  };

  /** The menu for whatever is under a screen point: an item (selected first), or the empty plot. */
  const openMenu = (pt: { x: number; y: number }) => {
    const svg = svgRef.current;
    const p = svg ? toPlot(svg, pt.x, pt.y) : null;
    if (!svg || !p) return;
    const under = document.elementFromPoint(pt.x, pt.y);
    const hit = under && svg.contains(under) ? under.closest("[data-id]") : null;
    // A handle belongs to the selected item.
    const id = hit?.getAttribute("data-id") ?? (under?.closest("[data-hd]") ? selectedId : null);
    if (id && id !== selectedId) dispatch({ type: "select", id });
    svg.focus({ preventScroll: true });
    showMenu(pt, id ? itemMenu(id) : canvasMenu(p));
  };
  const trigger = useContextMenuTrigger(openMenu);

  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    dispatch({ type: "commitGesture" });
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    svg.focus({ preventScroll: true });
    const handle = (e.target as Element).closest?.("[data-hd]");
    const hit = (e.target as Element).closest?.("[data-id]");
    // A finger landing while another drags an item: the drag ends, both pinch.
    if (drag.current && drag.current.pointerId !== e.pointerId) end();
    else if (e.button === 0 && (handle || hit) && !drag.current) {
      const id = hit?.getAttribute("data-id") ?? selectedId;
      const p = toPlot(svg, e.clientX, e.clientY);
      if (id && p) {
        if (id !== selectedId) dispatch({ type: "select", id });
        const base = { id, pointerId: e.pointerId, start: { x: p.x, y: p.y }, startPx: { x: e.clientX, y: e.clientY }, moved: false };
        const mode = handle?.getAttribute("data-hd");
        drag.current =
          mode === "pt"
            ? { ...base, mode, index: Number(handle!.getAttribute("data-pi")) }
            : { ...base, mode: mode === "size" || mode === "rot" ? mode : "move", below: handle?.hasAttribute("data-below") };
        pz.claim(e.pointerId);
      } else if (id && id !== selectedId) dispatch({ type: "select", id });
    } else if (!handle && !hit && selectedId) dispatch({ type: "select", id: null });
    pz.handlers.onPointerDown(e);
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      if (!d.moved && Math.hypot(e.clientX - d.startPx.x, e.clientY - d.startPx.y) < DRAG_SLOP_PX) return;
      // A drag is under way: a long press timing on the same finger must not open a menu over it.
      if (!d.moved) trigger.cancel();
      d.moved = true;
      const p = toPlot(e.currentTarget, e.clientX, e.clientY);
      if (p) {
        if (d.mode === "move") dispatch({ type: "move", id: d.id, dx: p.x - d.start.x, dy: p.y - d.start.y });
        else if (d.mode === "size") dispatch({ type: "resize", id: d.id, point: p, pad: HANDLE_PAD * p.k });
        else if (d.mode === "rot") {
          const it = itemsRef.current.find((x) => x.id === d.id);
          if (it) dispatch({ type: "rotate", id: d.id, angle: angleTo(it, p) + (d.below ? 180 : 0), step: e.shiftKey ? ROTATE_STEP_SHIFT : ROTATE_STEP });
        } else if (d.mode === "pt") dispatch({ type: "movePoint", id: d.id, index: d.index, point: p });
      }
    }
    pz.handlers.onPointerMove(e);
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === e.pointerId) end();
    pz.handlers.onPointerUp(e);
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const it = items.find((x) => x.id === selectedId);
    if (isMod(e)) {
      const key = e.key.toLowerCase();
      const arrange = ARRANGE_KEYS[e.code];
      if (arrange) {
        if (!it || e.shiftKey) return;
        dispatch({ type: "arrange", id: it.id, to: arrange[e.altKey ? 1 : 0] });
      } else if (e.altKey) return;
      else if (key === "v") paste();
      else if (it && key === "c") copy(it.id);
      else if (it && key === "x") copy(it.id, true);
      else if (it && key === "d") duplicate(it.id);
      else return;
      e.preventDefault();
      return;
    }
    if (!it) return;
    const step = e.shiftKey ? NUDGE_FAR : NUDGE;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (move) {
      e.preventDefault();
      dispatch({ type: "nudge", id: it.id, dx: move[0], dy: move[1] });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      dispatch({ type: "remove", id: it.id });
    }
  };

  return (
    // The long press (touch) and right-click (mouse) are heard on this wrapper, as the SVG's own events bubble.
    <div
      onContextMenu={trigger.onContextMenu}
      onPointerDown={trigger.onPointerDown}
      onPointerMove={trigger.onPointerMove}
      onPointerUp={trigger.onPointerUp}
      onPointerCancel={trigger.onPointerCancel}
      onClickCapture={trigger.onClickCapture}
      style={trigger.style}
    >
    <PlotSvg
      svgRef={svgRef}
      plot={{ name, items }}
      background={background}
      fade={fade}
      view={pz.view}
      selectedId={selectedId}
      gestures={{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }}
      className="w-full touch-none rounded-[0.875rem] outline-none focus-visible:ring-2 focus-visible:ring-focus [&_[data-id]]:cursor-move"
      svgProps={{ tabIndex: 0, role: "application", "aria-label": "Plot canvas", "data-testid": "canvas", onKeyDown } as SVGProps<SVGSVGElement>}
    />
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}
