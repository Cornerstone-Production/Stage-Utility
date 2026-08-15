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

function storedWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return DEFAULT_SIDEBAR_WIDTH;
    // A stored value out of range is clamped rather than trusted: the bounds can
    // change between releases, and a rail restored at 900px is unusable with no
    // obvious way back.
    return clampSidebarWidth(Number(raw));
  } catch {
    // localStorage unavailable (private mode etc.) — fall back to the default.
    return DEFAULT_SIDEBAR_WIDTH;
  }
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

export function useSidebarWidth(): SidebarWidth {
  const [width, setWidth] = useState<number>(storedWidth);
  const [dragging, setDragging] = useState(false);

  // The live width during a drag lives in a ref and is written to state once per
  // animation frame. Writing state on every pointermove re-renders the whole
  // shell per event, which is what makes a drag feel like jelly.
  const frame = useRef<number | null>(null);
  const pending = useRef<number | null>(null);

  const persist = useCallback((px: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
    } catch {
      // Width still applies for this session; it just will not survive a reload.
    }
  }, []);

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
        pending.current = clampSidebarWidth(startWidth + (ev.clientX - startX));
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
    [width, persist],
  );

  const reset = useCallback(() => {
    setWidth(DEFAULT_SIDEBAR_WIDTH);
    persist(DEFAULT_SIDEBAR_WIDTH);
  }, [persist]);

  return { width, dragging, startResize, reset };
}
