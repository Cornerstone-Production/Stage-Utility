// Customize mode: the real sidebar made editable in place, with a tray docked
// under the page.
//
// One provider at the shell, because the mode spans three places that do not
// share a parent below it: the rail (the sidebar prop of SplitView), the tray
// (under the page), and every way in (the rail's menu, Advanced > Layout). The
// drag spans two of them too: a tile is dragged from the tray into the rail, so
// both sit inside the one DndContext here. The drag itself is use-rail-drag.ts;
// this file holds the state and the saves.
//
// THE RAIL DRAWS A DRAFT AHEAD OF THE SAVED ARRANGEMENT. It reads the live SSE
// state, which an optimistic write to React Query never reaches, so a change
// would otherwise show only once its broadcast came back, and a refused save
// would leave nothing to put back. Every
// change sets the draft and saves; a refusal puts the draft back to what is
// saved. When the saved arrangement changes BY VALUE and no save of ours is in
// flight, the draft follows it: outside the mode it is dropped, and inside it
// is rebased, so another browser's change is not overwritten by our next drag.

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type Modifier } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontalIcon } from "lucide-react";

import {
  consoleViewId,
  isConsoleId,
  LOCKED_PAGE,
  resolveSidebar,
  sidebarConsolesOf,
  toSavedSidebar,
  type ResolvedSidebar,
  type SidebarArrangement,
  type SidebarConsoles,
} from "@main/services/sidebar-arrangement";
import { toast } from "../components/ui";
import { useResyncOn } from "../lib/use-resync-on";
import { useStageState } from "../main/use-stage-state";
import { dropPoint } from "./drag-geometry";
import { CustomizeContext, useCustomize, type CustomizeTab, type CustomizeValue } from "./customize-context";
import { setSidebar } from "./set-sidebar";
import { setViewShowInSidebar } from "./set-view-show-in-sidebar";
import { hidePage } from "./sidebar-edits";
import { BarDragGhost, RailDragGhost } from "./rail-drag-ghost";
import { isBarDrag, useBarEditor } from "./bar-editor";
import { usePointerSensors } from "./drag-parts";
import { useIsMobile } from "../lib/use-media-query";
import { ALL_DESTINATIONS } from "./destinations";
import { resolveIcon } from "../components/icon-set";
import { useRailDrag } from "./use-rail-drag";

export { useCustomize, type CustomizeTab, type CustomizeValue } from "./customize-context";

/** The drawn sidebar and its consoles, from a reading of the state and a draft. */
function useResolvedFromState(
  state: StageState | null | undefined,
  draft: SidebarArrangement | null,
): { resolved: ResolvedSidebar; consoles: SidebarConsoles } {
  const views = state?.views;
  const saved = state?.sidebar ?? null;
  const consoles = useMemo(() => sidebarConsolesOf(views), [views]);
  const resolved = useMemo(() => resolveSidebar(draft ?? saved, consoles), [draft, saved, consoles]);
  return { resolved, consoles };
}

/**
 * The sidebar to draw, from this component's own reading of the state plus any
 * draft the mode holds, so a rail rendered on its own (a test, a page with no
 * shell) still draws the operator's arrangement.
 */
export function useResolvedSidebar(): ResolvedSidebar {
  const { draft } = useCustomize();
  const { state } = useStageState();
  return useResolvedFromState(state, draft).resolved;
}

/**
 * Draw the ghost just below and right of the pointer, as the mockup does, rather
 * than over the row it came from: dragged from its middle, a row's ghost would
 * otherwise start half off the left edge of the screen.
 */
const besidePointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const start = dropPoint({ activatorEvent, delta: { x: 0, y: 0 } });
  if (!start) return transform;
  return {
    ...transform,
    x: transform.x + start.x - draggingNodeRect.left + 10,
    y: transform.y + start.y - draggingNodeRect.top + 10,
  };
};

const sameArrangement = (a: SidebarArrangement | null, b: SidebarArrangement | null) =>
  JSON.stringify(a) === JSON.stringify(b);

export function CustomizeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { state } = useStageState();
  const [customizing, setCustomizing] = useState(false);
  const [draft, setDraft] = useState<SidebarArrangement | null>(null);
  /** Saves of ours not yet answered. While one is out, a broadcast may be our
   *  own echo racing the answer, so the draft is not moved for it. */
  const [saving, setSaving] = useState(0);
  const { resolved, consoles } = useResolvedFromState(state, draft);
  const saved = state?.sidebar ?? null;
  // BY VALUE: every broadcast carries a new state object, and one about anything
  // else (a clock, a console) must not move the draft, or a Hide flickers back.
  const savedKey = useMemo(() => JSON.stringify(saved), [saved]);

  useResyncOn([savedKey], () => {
    if (saving > 0) return;
    setDraft(customizing ? saved : null);
  });

  const savedRef = useRef(saved);
  const customizingRef = useRef(customizing);
  useEffect(() => {
    savedRef.current = saved;
    customizingRef.current = customizing;
  });

  const commit = useCallback(
    async (next: SidebarArrangement): Promise<boolean> => {
      setDraft(next);
      setSaving((n) => n + 1);
      const ok = await setSidebar(queryClient, next);
      setSaving((n) => n - 1);
      if (!ok) setDraft(customizingRef.current ? savedRef.current : null);
      else if (!customizingRef.current && sameArrangement(savedRef.current, next)) setDraft(null);
      return ok;
    },
    [queryClient],
  );

  /** The Undo toast on screen, retired by the next change on either tab. */
  const undoToast = useRef<string | null>(null);
  const retireUndo = useCallback(() => {
    if (undoToast.current) toast.dismiss(undoToast.current);
    undoToast.current = null;
  }, []);
  const offerUndo = useCallback(
    (said: string, undo: () => void) => {
      retireUndo();
      const id = toast.withAction(said, {
        label: "Undo",
        onSelect: () => {
          if (undoToast.current === id) undoToast.current = null;
          undo();
        },
      });
      undoToast.current = id;
    },
    [retireUndo],
  );

  const apply = useCallback(
    (next: ResolvedSidebar | null, said?: string, undoable = false) => {
      if (!next) return;
      retireUndo();
      const before = toSavedSidebar(resolved, consoles);
      void commit(toSavedSidebar(next, consoles));
      if (!said) return;
      if (undoable) offerUndo(said, () => void commit(before));
      else toast.info(said);
    },
    [commit, consoles, offerUndo, resolved, retireUndo],
  );

  const setConsoleShown = useCallback(
    (id: string, shown: boolean, said?: string) => {
      void setViewShowInSidebar(queryClient, consoleViewId(id), shown);
      if (said) {
        toast.info(said, {
          action: { label: "Undo", onSelect: () => void setViewShowInSidebar(queryClient, consoleViewId(id), !shown) },
        });
      }
    },
    [queryClient],
  );

  const hide = useCallback(
    (id: string, label: string) => {
      if (id === LOCKED_PAGE) {
        toast.info("Advanced stays in the sidebar. It carries the update and server warnings.");
        return;
      }
      if (isConsoleId(id)) {
        setConsoleShown(id, false, `Hid ${label}. It still opens from Screens.`);
        return;
      }
      apply(hidePage(resolved, id), `Hid ${label}. It still opens from a link.`, true);
    },
    [apply, resolved, setConsoleShown],
  );

  const [tab, setTab] = useState<CustomizeTab>("sidebar");
  const open = useCallback((which: CustomizeTab) => {
    setDraft(savedRef.current);
    setTab(which);
    setCustomizing(true);
  }, []);
  const done = useCallback(() => {
    setCustomizing(false);
    setDraft(null);
  }, []);
  // On a phone the bar starts on its own set, the one that device shows.
  const isMobile = useIsMobile();
  const bar = useBarEditor({
    active: customizing && tab === "bar",
    opened: customizing,
    startOn: isMobile ? "mobile" : "desktop",
    undo: { offer: offerUndo, retire: retireUndo },
  });

  const glyphs = state?.iconGlyphs;
  const views = state?.views;
  const describe = useCallback(
    (id: string): { label: string; icon: ReactNode } | null => {
      const page = ALL_DESTINATIONS.find((d) => d.id === id);
      if (page) return { label: page.label, icon: page.icon };
      if (!isConsoleId(id)) return null;
      const view = views?.find((v) => v.id === consoleViewId(id));
      if (!view) return null;
      // The console's own glyph, the one its rail row wears.
      const glyph = resolveIcon(glyphs?.[view.id]) ?? SlidersHorizontalIcon;
      return { label: view.name, icon: createElement(glyph, { className: "size-4" }) };
    },
    [views, glyphs],
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);
  const railDrag = useRailDrag(resolved, listRef, { apply, hide, setConsoleShown, describe });
  const sensors = usePointerSensors();
  // One drag context for both editors; each drag goes to the editor it came from.
  /** Each drag goes to the editor it came from. */
  const route = (e: { active: { data: { current?: unknown } } }) => (isBarDrag(e.active.data.current) ? bar : railDrag);
  const drags = {
    onDragStart: (e: DragStartEvent) => route(e).onDragStart(e),
    onDragMove: (e: DragMoveEvent) => route(e).onDragMove(e),
    onDragEnd: (e: DragEndEvent) => route(e).onDragEnd(e),
    onDragCancel: () => {
      bar.onDragCancel();
      railDrag.onDragCancel();
    },
  };

  // Escape leaves the mode, as Done does. Not from a field: there Escape cancels
  // that field's edit (a heading's rename, the app name) and the mode stays. Not
  // while a menu or dialog is open, which Escape closes first, and not mid-drag,
  // where it cancels the drag.
  const dragging = railDrag.drag !== null || bar.dragging !== null;
  useEffect(() => {
    if (!customizing || dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role='menu'], [role='dialog'], [role='alertdialog']")) return;
      done();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [customizing, dragging, done]);

  const value: CustomizeValue = {
    customizing,
    tab,
    setTab,
    open,
    done,
    bar: customizing && tab === "bar" ? bar : null,
    resolved,
    draft,
    consoles,
    apply,
    setConsoleShown,
    hide,
    drag: railDrag.drag,
    aim: railDrag.aim,
    listRef,
    trayRef,
    describe,
  };

  return (
    <CustomizeContext value={value}>
      <DndContext
        sensors={sensors}
        // The rail's own autoscroll (use-rail-drag.ts): dnd-kit's scrolls the
        // ancestors of the dragged node, which for a tray tile is the tray.
        autoScroll={false}
        {...drags}
      >
        {children}
        {/* A bar drop that was not a place flies back where it came from, which
            is what "that did not take" looks like; anything else lands where it
            was let go. */}
        <DragOverlay dropAnimation={bar.dragging && !bar.wasPlaceable ? undefined : null} modifiers={[besidePointer]}>
          {railDrag.drag ? (
            <RailDragGhost drag={railDrag.drag} out={railDrag.aim.hiding} blocked={railDrag.aim.blocked} describe={describe} resolved={resolved} />
          ) : bar.dragging ? (
            <BarDragGhost id={bar.dragging} out={bar.removing} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </CustomizeContext>
  );
}
