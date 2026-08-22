// Draggable sidebar width, persisted.
//
// Separate from useSidebarCollapsed: collapse is a mode (icon rail vs labels),
// width is how wide the expanded rail is. Collapsing and re-expanding returns to
// the width you chose, rather than resetting it.

import { useCallback, useEffect, useRef, useState } from "react";

export const SIDEBAR_WIDTH_KEY = "stage-sidebar-width";

/** Matches the previous fixed `w-56`, so an operator who never drags sees no change. */
export const DEFAULT_SIDEBAR_WIDTH = 224;
/** Width of the collapsed icon rail. Fixed — only the expanded rail is draggable. */
export const RAIL_WIDTH = 56;
/** Narrow enough to be tight, wide enough that a label is still readable. */
export const MIN_SIDEBAR_WIDTH = 176;
/** Past this the rail is competing with the content rather than serving it. */
export const MAX_SIDEBAR_WIDTH = 420;

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(px)));
}


export interface PanelWidthOptions {
  /** localStorage key. Two panels must not share one. */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /**
   * Which edge the handle sits on.
   *
   * "left" grows rightward as the pointer moves right — the sidebar. "right"
   * grows LEFTWARD, which is what an inspector on the right side needs: dragging
   * its left edge toward the middle should make it wider, not narrower.
   */
  edge?: "left" | "right";
}

export interface SidebarWidth {
  width: number;
  /** True while a drag is in progress — lets the caller suppress transitions. */
  dragging: boolean;
  /** Attach to the drag handle's onPointerDown. */
  startResize: (e: React.PointerEvent<HTMLElement>) => void;
  /** Back to DEFAULT_SIDEBAR_WIDTH — the escape hatch from an awkward drag. */
  reset: () => void;
}

/**
 * A draggable, persisted panel width.
 *
 * One implementation, used by the sidebar and the editor's inspector. A second
 * copy is how the two drift into behaving differently — one with rAF batching
 * and pointercancel handling, the other without.
 */
export function usePanelWidth(opts: PanelWidthOptions): SidebarWidth {
  const { storageKey, defaultWidth, min, max, edge = "left" } = opts;
  const clamp = useCallback(
    (px: number) => (!Number.isFinite(px) ? defaultWidth : Math.min(max, Math.max(min, Math.round(px)))),
    [defaultWidth, min, max],
  );
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? defaultWidth : clamp(Number(raw));
    } catch {
      return defaultWidth;
    }
  });
  const [dragging, setDragging] = useState(false);

  // The live width during a drag lives in a ref and is written to state once per
  // animation frame. Writing state on every pointermove re-renders the whole
  // shell per event, which is what makes a drag feel like jelly.
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);

  const persist = useCallback((px: number) => {
    try {
      localStorage.setItem(storageKey, String(px));
    } catch {
      // Width still applies for this session; it just will not survive a reload.
    }
  }, [storageKey]);

  // A drag that ends while the component is unmounting must not leave a frame
  // queued against a dead component.
  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  const startResize = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Left button only; a right-click drag would otherwise resize the rail.
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startWidth = width;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        pending.current = clamp(startWidth + (edge === "right" ? -delta : delta));
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (pending.current !== null) setWidth(pending.current);
        });
      };

      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        if (frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
        const final = pending.current ?? startWidth;
        pending.current = null;
        setWidth(final);
        setDragging(false);
        persist(final);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      // pointercancel matters on touch: a browser gesture can steal the pointer
      // mid-drag, and without this the rail stays stuck in dragging state.
      handle.addEventListener("pointercancel", onUp);
    },
    [width, persist, clamp, edge],
  );

  const reset = useCallback(() => {
    setWidth(defaultWidth);
    persist(defaultWidth);
  }, [persist, defaultWidth]);

  return { width, dragging, startResize, reset };
}

/** The sidebar, as a thin wrapper — same drag, its own key and bounds. */
export function useSidebarWidth(): SidebarWidth {
  return usePanelWidth({
    storageKey: SIDEBAR_WIDTH_KEY,
    defaultWidth: DEFAULT_SIDEBAR_WIDTH,
    min: MIN_SIDEBAR_WIDTH,
    max: MAX_SIDEBAR_WIDTH,
  });
}

/** The layout editor's inspector. Grows leftward: its handle is on its left edge. */
export const INSPECTOR_WIDTH_KEY = "stage-inspector-width";
export const DEFAULT_INSPECTOR_WIDTH = 320;
/**
 * The same floor the left sidebar has.
 *
 * It was 260, and the contents did not fit even there: the tint swatches and
 * the alignment buttons overflowed by 26px and 16px, so the panel scrolled
 * sideways at its own minimum. The rows stack and wrap below 248px (see Row in
 * inspector-rows), which is what lets this come down to match the rail.
 */
export const MIN_INSPECTOR_WIDTH = MIN_SIDEBAR_WIDTH;
export const MAX_INSPECTOR_WIDTH = 640;

export function useInspectorWidth(): SidebarWidth {
  return usePanelWidth({
    storageKey: INSPECTOR_WIDTH_KEY,
    defaultWidth: DEFAULT_INSPECTOR_WIDTH,
    min: MIN_INSPECTOR_WIDTH,
    max: MAX_INSPECTOR_WIDTH,
    edge: "right",
  });
}
