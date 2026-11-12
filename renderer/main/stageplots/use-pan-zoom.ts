// use-pan-zoom.ts — zoom and pan a plot by moving its SVG viewBox.
//
// Drag pans, two fingers pinch, a trackpad pinch (a wheel event with ctrl or
// cmd held) zooms at the pointer, and an ordinary wheel pans only once zoomed
// in, so scrolling past a plot on a page still scrolls the page. Buttons zoom
// in, out and back to the whole plot.
//
// The geometry is pure functions below; the pointer handling needs a layout
// engine (jsdom measures every element as 0 by 0) and is checked in a browser.

import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

import { clamp } from "@main/services/clamp";

import { useLatestRef } from "../../lib/use-latest-ref";
import { useResyncOn } from "../../lib/use-resync-on";

/** The part of the plot on screen, in plot units. */
export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Zoomed in at most this far: one eighth of the plot fills the frame. */
export const MAX_ZOOM = 8;
/** What one press of zoom in or out multiplies the zoom by. */
export const ZOOM_STEP = 1.25;


export function fitView(full: { w: number; h: number }): View {
  return { x: 0, y: 0, w: full.w, h: full.h };
}

/** `view` moved back inside the plot. */
export function clampView(view: View, full: { w: number; h: number }): View {
  return { ...view, x: clamp(view.x, 0, full.w - view.w), y: clamp(view.y, 0, full.h - view.h) };
}

/** Zoom by `factor` (above 1 is in) keeping the plot point `at` where it is. */
export function zoomView(view: View, full: { w: number; h: number }, factor: number, at: { x: number; y: number }): View {
  const w = clamp(view.w / factor, full.w / MAX_ZOOM, full.w);
  const k = w / view.w;
  return clampView({ x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k, w, h: view.h * k }, full);
}

/** Pan by a distance in plot units: the drawing follows the pointer. */
export function panView(view: View, full: { w: number; h: number }, dx: number, dy: number): View {
  return clampView({ ...view, x: view.x - dx, y: view.y - dy }, full);
}

export interface PanZoom {
  viewBox: string;
  /** 1 is the whole plot. */
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  /** Spread onto the SVG. */
  handlers: {
    onPointerDown: (e: PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: PointerEvent<SVGSVGElement>) => void;
    onPointerCancel: (e: PointerEvent<SVGSVGElement>) => void;
  };
}

export function usePanZoom(svgRef: RefObject<SVGSVGElement | null>, fullW: number, fullH: number): PanZoom {
  const [view, setView] = useState<View>(() => fitView({ w: fullW, h: fullH }));
  useResyncOn([fullW, fullH], () => setView(fitView({ w: fullW, h: fullH })));
  const viewRef = useLatestRef(view);
  const fullRef = useLatestRef({ w: fullW, h: fullH });
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  /** Plot units per screen pixel, and the frame's box. */
  const measure = () => {
    const r = svgRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? { r, k: viewRef.current.w / r.width } : null;
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      const m = measure();
      if (!m) return;
      const v = viewRef.current;
      const full = fullRef.current;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const at = { x: v.x + (e.clientX - m.r.left) * m.k, y: v.y + (e.clientY - m.r.top) * m.k };
        setView(zoomView(v, full, Math.exp(-e.deltaY * 0.003), at));
      } else if (v.w < full.w) {
        e.preventDefault();
        setView(panView(v, full, -e.deltaX * m.k, -e.deltaY * m.k));
      }
    };
    // Not React's onWheel: that listener is passive and cannot stop the page scrolling.
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRef]);

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Capture keeps a drag that leaves the plot panning it. A pointer the browser
    // no longer counts as active cannot be captured, and the gesture still works
    // without it, so that refusal is not a failure worth stopping for.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId) === false) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* see above */
      }
    }
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const ps = pointers.current;
    const prev = ps.get(e.pointerId);
    if (!prev) return;
    const m = measure();
    if (!m) return;
    const v = viewRef.current;
    const full = fullRef.current;
    if (ps.size === 1) {
      setView(panView(v, full, (e.clientX - prev.x) * m.k, (e.clientY - prev.y) * m.k));
    } else if (ps.size === 2) {
      const other = [...ps.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const mid0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const mid1 = { x: (e.clientX + other.x) / 2, y: (e.clientY + other.y) / 2 };
      const at = { x: v.x + (mid0.x - m.r.left) * m.k, y: v.y + (mid0.y - m.r.top) * m.k };
      const zoomed = zoomView(v, full, before > 0 ? after / before : 1, at);
      const k = zoomed.w / m.r.width;
      setView(panView(zoomed, full, (mid1.x - mid0.x) * k, (mid1.y - mid0.y) * k));
    }
    ps.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
  };

  const center = () => ({ x: view.x + view.w / 2, y: view.y + view.h / 2 });
  return {
    viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`,
    zoom: fullW / view.w,
    zoomIn: () => setView(zoomView(view, { w: fullW, h: fullH }, ZOOM_STEP, center())),
    zoomOut: () => setView(zoomView(view, { w: fullW, h: fullH }, 1 / ZOOM_STEP, center())),
    fit: () => setView(fitView({ w: fullW, h: fullH })),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
