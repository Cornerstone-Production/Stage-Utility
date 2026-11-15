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
// would leave nothing to put back (bar-configurator.tsx learned the same). Every
// change sets the draft and saves; a refusal puts the draft back to what is
// saved. When the saved arrangement changes BY VALUE and no save of ours is in
// flight, the draft follows it: outside the mode it is dropped, and inside it
// is rebased, so another browser's change is not overwritten by our next drag.

import { createContext, createElement, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { DndContext, DragOverlay, type Modifier } from "@dnd-kit/core";
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
import { dropPoint } from "./bar-drop";
import { NO_AIM, type RailAim, type RailDrag } from "./rail-drop";
import { setSidebar } from "./set-sidebar";
import { setViewShowInSidebar } from "./set-view-show-in-sidebar";
import { hidePage } from "./sidebar-edits";
import { RailDragGhost } from "./rail-drag-ghost";
import { ALL_DESTINATIONS } from "./destinations";
import { resolveIcon } from "../components/icon-set";
import { useRailDrag } from "./use-rail-drag";

export interface CustomizeValue {
  customizing: boolean;
  open: () => void;
  done: () => void;
  /** The sidebar to draw: the draft while one is held, else what is saved. */
  resolved: ResolvedSidebar;
  /** The arrangement held ahead of the SSE state, or null. */
  draft: SidebarArrangement | null;
  consoles: SidebarConsoles;
  /**
   * Save a change. Null (an edit that broke a rule) does nothing. `said` is
   * toasted; with `undoable` it carries an Undo, which a newer change retires,
   * so an Undo only ever puts back the change it was offered for.
   */
  apply: (next: ResolvedSidebar | null, said?: string, undoable?: boolean) => void;
  /** List a console in the sidebar, or take it out, through its own switch. */
  setConsoleShown: (id: string, shown: boolean, said?: string) => void;
  /** Hide a page or a console, saying so with an Undo. Advanced says why not. */
  hide: (id: string, label: string) => void;
  drag: RailDrag | null;
  aim: RailAim;
  /** The rail list, which the rail registers so the drag can measure it. */
  listRef: RefObject<HTMLDivElement | null>;
  /** The tray, likewise. */
  trayRef: RefObject<HTMLDivElement | null>;
  /** A page's or console's name and icon, for the tray and the drag ghost. */
  describe: (id: string) => { label: string; icon: ReactNode } | null;
}

const noop = () => {};
const EMPTY_CONSOLES: SidebarConsoles = { all: [], hidden: new Set() };

/** Outside a shell (a test rendering one page) the mode is closed and inert. */
const CustomizeContext = createContext<CustomizeValue>({
  customizing: false,
  open: noop,
  done: noop,
  resolved: resolveSidebar(null, EMPTY_CONSOLES),
  draft: null,
  consoles: EMPTY_CONSOLES,
  apply: noop,
  setConsoleShown: noop,
  hide: noop,
  drag: null,
  aim: NO_AIM,
  listRef: { current: null },
  trayRef: { current: null },
  describe: () => null,
});

export function useCustomize(): CustomizeValue {
  return use(CustomizeContext);
}

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

  /** The Undo toast on screen, retired by the next change. */
  const undoToast = useRef<string | null>(null);

  const apply = useCallback(
    (next: ResolvedSidebar | null, said?: string, undoable = false) => {
      if (!next) return;
      if (undoToast.current) toast.dismiss(undoToast.current);
      undoToast.current = null;
      const before = toSavedSidebar(resolved, consoles);
      void commit(toSavedSidebar(next, consoles));
      if (!said) return;
      if (!undoable) {
        toast.info(said);
        return;
      }
      const id = toast.withAction(said, {
        label: "Undo",
        onSelect: () => {
          if (undoToast.current === id) undoToast.current = null;
          void commit(before);
        },
      });
      undoToast.current = id;
    },
    [commit, consoles, resolved],
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

  const open = useCallback(() => {
    setDraft(savedRef.current);
    setCustomizing(true);
  }, []);
  const done = useCallback(() => {
    setCustomizing(false);
    setDraft(null);
  }, []);

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

  const value: CustomizeValue = {
    customizing,
    open,
    done,
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
        sensors={railDrag.sensors}
        // The rail's own autoscroll (use-rail-drag.ts): dnd-kit's scrolls the
        // ancestors of the dragged node, which for a tray tile is the tray.
        autoScroll={false}
        onDragStart={railDrag.onDragStart}
        onDragMove={railDrag.onDragMove}
        onDragEnd={railDrag.onDragEnd}
        onDragCancel={railDrag.onDragCancel}
      >
        {children}
        <DragOverlay dropAnimation={null} modifiers={[besidePointer]}>
          {railDrag.drag ? (
            <RailDragGhost drag={railDrag.drag} out={railDrag.aim.hiding} describe={describe} resolved={resolved} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </CustomizeContext>
  );
}
