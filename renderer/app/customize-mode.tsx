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
// state, which a write to React Query never reaches ahead of the broadcast, so a
// change would otherwise show only once its broadcast came back, and a refused
// save would leave nothing to put back. The arrangement is saved like any list
// the server holds whole (use-saved-list.ts): a change is a function of the
// arrangement it lands on, one save is out at a time, the draft is the server's
// last answer with the changes still waiting applied, and a refusal drops its
// change and reads the arrangement back. Another browser's change is taken in
// when nothing of ours is waiting; our own echo is not.

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent, type Modifier } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontalIcon } from "lucide-react";

import {
  consoleViewId,
  EMPTY_SIDEBAR,
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
import { useStageState } from "../main/use-stage-state";
import { dropPoint } from "./drag-geometry";
import { CustomizeContext, useCustomize, type CustomizeTab, type CustomizeValue } from "./customize-context";
import { sidebarListIo } from "./set-sidebar";
import { useSavedList } from "./use-saved-list";
import { setViewShowInSidebar } from "./set-view-show-in-sidebar";
import { addSection, hidePage } from "./sidebar-edits";
import { uid } from "../lib/uid";
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

/** The arrangement is a list of one: what two lists mean, for telling an echo from news. */
const keyOfArrangement = (list: SidebarArrangement[]) => JSON.stringify(list[0] ?? null);

export function CustomizeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { state } = useStageState();
  const [customizing, setCustomizing] = useState(false);

  // BY VALUE: every broadcast carries a new state object, and one about anything
  // else (a clock, a console) must not move the draft, or a Hide flickers back.
  const savedKey = state ? JSON.stringify(state.sidebar ?? EMPTY_SIDEBAR) : null;
  const savedList = useMemo(() => (savedKey === null ? null : [JSON.parse(savedKey) as SidebarArrangement]), [savedKey]);
  const io = useMemo(() => sidebarListIo(queryClient), [queryClient]);
  const { list, edit } = useSavedList({ io, saved: savedList, keyOf: keyOfArrangement });
  // The draft is held while the mode is on, and outside it for as long as the
  // broadcast of our last save has not arrived: dropped sooner, the rail would
  // flicker back to the arrangement before it.
  const held = list[0];
  const draft = held && (customizing || JSON.stringify(held) !== savedKey) ? held : null;
  const { resolved, consoles } = useResolvedFromState(state, draft);
  const consolesRef = useRef(consoles);
  useEffect(() => {
    consolesRef.current = consoles;
  });

  /** The Undo toast on screen, retired by the next change on either tab. */
  const undoToast = useRef<string | null>(null);
  const undoTicket = useRef(0);
  const retireUndo = useCallback(() => {
    if (undoToast.current) toast.dismiss(undoToast.current);
    undoToast.current = null;
    return ++undoTicket.current;
  }, []);
  const offerUndo = useCallback((said: string, undo: () => void, ticket: number) => {
    // A change made since this one retired its Undo: it is not offered late.
    if (ticket !== undoTicket.current) return;
    if (undoToast.current) toast.dismiss(undoToast.current);
    const id = toast.withAction(said, {
      label: "Undo",
      onSelect: () => {
        if (undoToast.current === id) undoToast.current = null;
        undo();
      },
    });
    undoToast.current = id;
  }, []);

  /** Save a change, saying the server's words if it is refused. Whether it saved. */
  const save = useCallback(
    async (change: (arrangement: SidebarArrangement) => SidebarArrangement | null): Promise<boolean> => {
      const result = await edit((l) => {
        const next = change(l[0] ?? EMPTY_SIDEBAR);
        return next ? [next] : l;
      });
      if (!result.ok) toast.error(result.error);
      return result.ok;
    },
    [edit],
  );

  const apply = useCallback(
    async (change: (r: ResolvedSidebar) => ResolvedSidebar | null, said?: string, undoable = false) => {
      // A rule refused it: nothing to save, nothing to say.
      if (!change(resolved)) return;
      const ticket = retireUndo();
      const before = toSavedSidebar(resolved, consoles);
      const saved = await save((arrangement) => {
        const next = change(resolveSidebar(arrangement, consolesRef.current));
        return next ? toSavedSidebar(next, consolesRef.current) : null;
      });
      // Said once it has saved: not for a change the server refused.
      if (!saved || !said) return;
      if (undoable) {
        offerUndo(said, () => {
          retireUndo();
          void save(() => before);
        }, ticket);
      } else toast.info(said);
    },
    [consoles, offerUndo, resolved, retireUndo, save],
  );

  const setConsoleShown = useCallback(
    async (id: string, shown: boolean, said?: string) => {
      const saved = await setViewShowInSidebar(queryClient, consoleViewId(id), shown);
      // Said once it has saved: not for a change the server refused.
      if (saved && said) {
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
      apply((r) => hidePage(r, id), `Hid ${label}. It still opens from a link.`, true);
    },
    [apply, setConsoleShown],
  );

  /** A new, empty section at the end; its id. The id is made here, once: a change is
   *  run again for every redraw and for the save, and an id made inside it would be a
   *  different section each time, so a rename or a drop on the drawn one would miss
   *  the saved one. */
  const addNewSection = useCallback(() => {
    const id = uid("s");
    void apply((r) => addSection(r, id));
    return id;
  }, [apply]);

  const [tab, setTab] = useState<CustomizeTab>("sidebar");
  const open = useCallback((which: CustomizeTab) => {
    setTab(which);
    setCustomizing(true);
  }, []);
  const done = useCallback(() => setCustomizing(false), []);
  // On a phone the bar starts on its own set, the one that device shows.
  const isMobile = useIsMobile();
  const bar = useBarEditor({
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
    addSection: addNewSection,
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
