// The drag over the sidebar in Customize mode: measuring, aim, the
// rail's own autoscroll, and what a drop does.
//
// Geometry, not droppables, as in the bar's editor (bar-editor.tsx explains
// why): the rows that hold still are measured once when the drag starts, and one
// function answers both "where is the caret" and "where does the drop go". The
// arithmetic is in rail-drop.ts, where it is tested.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { canPlace, isConsoleId, LOCKED_PAGE, type ResolvedSidebar } from "@main/services/sidebar-arrangement";
import { dropPoint, pointInBox } from "./drag-geometry";
import { NO_AIM, rowPlace, sectionPlace, type RailAim, type RailDrag, type RailItem } from "./rail-drop";
import { moveSection, movePage, sectionOf } from "./sidebar-edits";

/** How far from the rail list's edge a drag starts scrolling it, and how fast. */
const SCROLL_EDGE_PX = 40;
const SCROLL_STEP_PX = 12;

type Target =
  | { kind: "row"; section: string; index: number; caretY: number | null }
  | { kind: "head"; before: string | null; caretY: number }
  | { kind: "out" }
  | { kind: "none" };

export interface RailDropActions {
  apply: (next: ResolvedSidebar | null) => void;
  hide: (id: string, label: string) => void;
  setConsoleShown: (id: string, shown: boolean) => void;
  describe: (id: string) => { label: string } | null;
}

export function useRailDrag(resolved: ResolvedSidebar, listRef: RefObject<HTMLDivElement | null>, act: RailDropActions) {
  const [drag, setDrag] = useState<RailDrag | null>(null);
  const [aim, setAim] = useState<RailAim>(NO_AIM);
  const still = useRef<{ items: RailItem[]; heads: RailItem[]; endY: number; sections: string[] }>({
    items: [],
    heads: [],
    endY: 0,
    sections: [],
  });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const scrollTimer = useRef<number | null>(null);

  const scroller = () => listRef.current?.closest<HTMLElement>("[data-rail-scroller]") ?? null;

  /** ONE function for the caret and the drop. */
  function targetAt(d: RailDrag, p: { x: number; y: number } | null): Target {
    const list = listRef.current;
    const box = scroller()?.getBoundingClientRect() ?? list?.getBoundingClientRect() ?? null;
    if (!list || !p) return { kind: "none" };
    if (!pointInBox(box, p)) return d.kind === "head" ? { kind: "none" } : { kind: "out" };
    const y = p.y - list.getBoundingClientRect().top;
    if (d.kind === "head") return { kind: "head", ...sectionPlace(still.current.heads, y, still.current.endY) };
    const place = rowPlace(still.current.items, still.current.sections, y);
    if (!place) return { kind: "none" };
    const section = resolved.sections.find((s) => s.id === place.section);
    // Consoles holds consoles only: a drop that breaks it shows no caret and does nothing.
    if (!section || !canPlace(d.id, section)) return { kind: "none" };
    return { kind: "row", ...place };
  }

  function aimFor(d: RailDrag, t: Target): RailAim {
    if (t.kind === "out") {
      const row = d.kind === "row";
      return { caretY: null, dz: null, hiding: row && d.id !== LOCKED_PAGE, blocked: row && d.id === LOCKED_PAGE };
    }
    if (t.kind === "row") return { caretY: t.caretY, dz: t.caretY === null ? t.section : null, hiding: false, blocked: false };
    if (t.kind === "head") return { caretY: t.caretY, dz: null, hiding: false, blocked: false };
    return NO_AIM;
  }

  function measure(active: RailDrag) {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const items: RailItem[] = [];
    const heads: RailItem[] = [];
    for (const el of list.querySelectorAll<HTMLElement>("[data-rail-item]")) {
      const kind = el.dataset.railItem as RailItem["kind"];
      const section = el.dataset.section ?? "";
      // The dragged row, or the dragged section's heading, is leaving its place:
      // left out, one gap rule serves a reorder and an insert alike.
      if (active.kind === "row" && kind === "row" && el.dataset.id === active.id) continue;
      if (active.kind === "head" && section === active.id) continue;
      const r = el.getBoundingClientRect();
      const item = { kind, section, top: r.top - top, bottom: r.bottom - top };
      items.push(item);
      if (kind === "head") heads.push(item);
    }
    const add = list.querySelector<HTMLElement>("[data-rail-add]");
    const endY = add ? add.getBoundingClientRect().top - top - 6 : (items.at(-1)?.bottom ?? 0) + 2;
    still.current = { items, heads, endY, sections: resolved.sections.map((s) => s.id) };
  }

  function stopScrolling() {
    if (scrollTimer.current != null) cancelAnimationFrame(scrollTimer.current);
    scrollTimer.current = null;
  }

  /** Scroll the rail list while the pointer rests near its top or bottom edge:
   *  in the mode it is taller than most screens. */
  function autoscroll(d: RailDrag) {
    stopScrolling();
    const tick = () => {
      const el = scroller();
      const p = pointer.current;
      if (el && p) {
        const r = el.getBoundingClientRect();
        let step = 0;
        if (p.x >= r.left && p.x <= r.right) {
          if (p.y < r.top + SCROLL_EDGE_PX && p.y >= r.top - SCROLL_EDGE_PX) step = -SCROLL_STEP_PX;
          else if (p.y > r.bottom - SCROLL_EDGE_PX && p.y <= r.bottom + SCROLL_EDGE_PX) step = SCROLL_STEP_PX;
        }
        if (step !== 0 && el.scrollHeight > el.clientHeight) {
          el.scrollTop += step;
          setAim(aimFor(d, targetAt(d, p)));
        }
      }
      scrollTimer.current = requestAnimationFrame(tick);
    };
    scrollTimer.current = requestAnimationFrame(tick);
  }

  /**
   * The pointer, read from the window rather than from dnd-kit's delta. The
   * delta folds in how far the dragged node's scrolling ancestors moved, so once
   * the rail list autoscrolls under a drag it no longer says where the pointer
   * is: a heading dropped after an autoscroll landed a scroll's height away.
   */
  const trackPointer = useCallback((e: PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY };
  }, []);

  function endDrag() {
    stopScrolling();
    window.removeEventListener("pointermove", trackPointer);
    setDrag(null);
    setAim(NO_AIM);
    pointer.current = null;
  }

  useEffect(
    () => () => {
      stopScrolling();
      window.removeEventListener("pointermove", trackPointer);
    },
    [trackPointer],
  );

  function onDragStart(e: DragStartEvent) {
    const d = e.active.data.current as RailDrag | undefined;
    if (!d) return;
    pointer.current = dropPoint({ activatorEvent: e.activatorEvent, delta: { x: 0, y: 0 } });
    window.addEventListener("pointermove", trackPointer, { passive: true });
    measure(d);
    setDrag(d);
    setAim(NO_AIM);
    autoscroll(d);
  }

  function onDragMove(e: DragMoveEvent) {
    const d = e.active.data.current as RailDrag | undefined;
    if (!d) return;
    setAim(aimFor(d, targetAt(d, pointer.current ?? dropPoint(e))));
  }

  function onDragEnd(e: DragEndEvent) {
    const d = e.active.data.current as RailDrag | undefined;
    const at = pointer.current ?? dropPoint(e);
    endDrag();
    if (!d) return;
    const t = targetAt(d, at);
    if (t.kind === "none") return;
    if (d.kind === "head") {
      if (t.kind === "head") act.apply(moveSection(resolved, d.id, t.before));
      return;
    }
    if (t.kind === "out") {
      // A tile dropped anywhere off the rail flies home; a row is hidden.
      if (d.kind === "row") act.hide(d.id, act.describe(d.id)?.label ?? "the page");
      return;
    }
    if (t.kind !== "row") return;
    // A row dropped back where it was changes nothing and saves nothing.
    const from = sectionOf(resolved, d.id);
    if (from?.id === t.section) {
      const staying = from.members.filter((m) => m !== d.id);
      if (from.members.indexOf(d.id) === Math.min(t.index, staying.length)) return;
    }
    act.apply(movePage(resolved, d.id, t.section, t.index));
    // A hidden console's tile lands where the caret said, then comes back through
    // its own switch: the place is saved first, so it appears there.
    if (d.kind === "tile" && isConsoleId(d.id)) act.setConsoleShown(d.id, true);
  }

  return { drag, aim, onDragStart, onDragMove, onDragEnd, onDragCancel: endDrag };
}
