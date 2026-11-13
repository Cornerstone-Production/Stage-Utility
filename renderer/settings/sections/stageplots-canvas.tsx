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
// while the canvas has focus; a press on it focuses it. Undo and redo keys are
// the page's (stageplots-edit.tsx).
//
// What jsdom cannot show: real pointer capture, the SVG's measured box, pinch.
// The tests stub the box; the rest is driven in a browser.

import { useRef, type KeyboardEvent, type PointerEvent, type RefObject, type SVGProps } from "react";

import type { BackgroundView, PlotItem } from "@main/types/stageplots";

import { useLatestRef } from "../../lib/use-latest-ref";
import { HANDLE_PAD } from "../../main/stageplots/plot-items";
import { PlotSvg } from "../../main/stageplots/plot-svg";
import type { EditorAction } from "../../main/stageplots/editor-state";
import { angleTo } from "../../main/stageplots/geometry";
import type { PanZoom } from "../../main/stageplots/use-pan-zoom";

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
function toPlot(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number; k: number } | null {
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
}

export function StagePlotsCanvas({ name, items, selectedId, background, fade, pz, svgRef, dispatch }: CanvasProps) {
  const drag = useRef<Drag | null>(null);
  const itemsRef = useLatestRef(items);

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
      d.moved = true;
      const p = toPlot(e.currentTarget, e.clientX, e.clientY);
      if (p) {
        if (d.mode === "move") dispatch({ type: "move", id: d.id, dx: p.x - d.start.x, dy: p.y - d.start.y });
        else if (d.mode === "size") dispatch({ type: "resize", id: d.id, point: p, pad: HANDLE_PAD * p.k });
        else if (d.mode === "rot") {
          const it = itemsRef.current.find((x) => x.id === d.id);
          if (it) dispatch({ type: "rotate", id: d.id, angle: angleTo(it, p) + (d.below ? 180 : 0) });
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
  );
}
