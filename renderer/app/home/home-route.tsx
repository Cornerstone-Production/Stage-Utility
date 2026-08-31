// Home, at the root URL.
//
// Replaces the display picker, which was a list of links. Two states, chosen by
// whether PCO reports a service running — see home-mode.ts for why "none" is a
// payload rather than an absence.
//
// The plan picker is NOT here any more. It lived on Home while Home was a fixed
// page; once Home became a grid the operator arranges, a block of PCO controls
// they could neither move nor remove was furniture. It has its own page at
// /plan — its original URL — under Services.
//
// The cards are Home's View (main/services/home-view.ts), read for presence,
// ORDER and grid size — Home has no canvas, and editing happens right here.
//
// Nothing else lives on this page any more. The plan picker moved to /plan, and
// the "use this screen as a display" panel went entirely: Screens already lists
// every display with its URL, which is the same job done in the place you go to
// think about screens.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Loader2Icon, PencilIcon, CheckIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../../main/use-dashboard-state";
import { useStageSettings } from "../use-stage-settings";
import { GettingStarted } from "../../settings/getting-started";
import { usePageActions } from "../page-actions";
import { Button } from "../../components/ui/button";
import { PlusIcon, LayoutGridIcon } from "lucide-react";
import { flashTarget } from "../flash";
import { HOME_VIEW_ID, defaultHomeLayout } from "@main/services/home-view";
import type { LayoutObject } from "@main/types/views";
import { computePcoTimer } from "../../main/pco-timer";
import { homeMode } from "./home-mode";
import { addCard, cardsForNow, removeCard, replaceCard, setSize, setWhen } from "./home-cards";
import { SIZES, SIZE_ORDER, WHEN_LABELS, sizeOf, whenOf } from "./home-cards";
import { pickedValue, togglesFor, withToggle } from "./card-toggles";
import { gameOptions } from "../../main/scores-object";
import { invoke } from "../../lib/api";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { LAYOUT_OBJECTS } from "../../main/layout-objects";
import type { HomeCardSize, HomeVisibility } from "@main/types/views";
import { ROW_PX, GRID_GAP_PX } from "./home-grid";
import { COLUMNS } from "./home-cards";
import {
  boxesOf, clampCol, isPlaced, placeAt, placeNewCard, pushAway, resetPlacement, type Box,
} from "./home-placement";
import { HomeGrid } from "./home-grid";
import { AddWidgetSheet, CardChrome } from "./home-editor";

export function HomeRoute() {
  const { pcoLive, pcoLiveKnown } = useDashboardState();
  const s = useStageSettings();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  /** The cell the drag is currently over, so the page can show what dropping
   *  here would do before the operator commits to it. */
  const [dropCell, setDropCell] = useState<{ col: number; row: number } | null>(null);
  /**
   * The right-click menu on a card, if one is open.
   *
   * The CARD ID and a position — never the built items. Items built once and
   * kept in state close over the object list from the render that built them,
   * and `editRef` is cleared the moment the save comes back: the second click on
   * a checkable item then computed its new value from a stale card and wrote the
   * value that was already there. The tick moved and nothing else did.
   *
   * Rebuilt from the live list on every render instead, so the ticks and the
   * writes can never disagree.
   */
  const [menu, setMenu] = useState<{ x: number; y: number; cardId: string } | null>(null);
  const gridEl = useRef<HTMLDivElement | null>(null);
  /** The card list as the operator has it, ahead of the server. See `save`. */
  const [pending, setPending] = useState<LayoutObject[] | null>(null);
  /** The same list, readable synchronously inside one React batch. Written in
   *  `save` only — never during a render. */
  const editRef = useRef<LayoutObject[] | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    // Cleanup is load-bearing: the shell is persistent, so an interval that
    // outlives this route runs for the whole service.
    return () => clearInterval(id);
  }, []);

  // Skew between this client and the server, recomputed whenever a pco:live
  // arrives. Same pattern as dashboard-view.tsx and the context bar.
  const [skewMs, setSkewMs] = useState(0);
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

  // The server has caught up — stop preferring the optimistic copy, so an edit
  // made anywhere else (a restored snapshot, a second tab) is not masked forever.
  // ABOVE the loading return, because a hook cannot be called conditionally --
  // eslint caught these sitting below it. Read straight off the (possibly
  // absent) state rather than from the derived `home` further down, which does
  // not exist yet at this point in the render.
  //
  // ONE lookup: the same find ran three times, for the revision, for presence
  // and for the placed check.
  const homeView = s.stageState?.views?.find((v) => v.id === HOME_VIEW_ID);
  const savedRev = homeView?.layoutRev ?? 0;
  useResyncOn([savedRev], () => {
    setPending(null);
    editRef.current = null;
  });

  const hasHome = homeView != null;
  /**
   * The followed teams, for the "Game" submenu on a scores card.
   *
   * The SAME query key the settings panel and the layout inspector use, so
   * following a team in Settings populates this menu without a reload.
   *
   * Only fetched once a card that can use it is on the page. Home is the front
   * page every operator lands on, and firing an integration read there for a
   * widget nobody placed is exactly the kind of always-on request this app tries
   * not to make. Read from the operator's optimistic copy first so a scores card
   * added a moment ago counts immediately.
   */
  const wantsFavourites = (pending ?? homeView?.layout?.objects ?? []).some(
    (o) => pickedValue(o, "game") != null,
  );
  const { data: scoresConfig } = useQuery({
    queryKey: ["scores:getFavourites"],
    queryFn: () => invoke<ScoresConfig>("scores:getFavourites"),
    enabled: wantsFavourites,
    retry: 1,
  });
  /** Has anything been placed by hand? */
  const arranged = (homeView?.layout?.objects ?? []).some((o) => isPlaced(o));
  // The controls live in the page HEADER, not on a row of their own — that row
  // held one link and cost a whole band of the page that most wants the height.
  // Icon squares, matching the object controls in the custom-view editor.
  usePageActions(
    hasHome ? (
      <>
        {editing && (
          <Button
            variant="filled"
            size="medium"
            iconOnly
            onClick={() => setAdding(true)}
            aria-label="Add widget"
          >
            <PlusIcon className="size-4" />
          </Button>
        )}
        {/* The way back from an arrangement that got away from you: drop every
            hand placement and let the page pack itself again. Only offered once
            something HAS been placed, so it is never a button that does nothing. */}
        {editing && arranged && (
          <Button
            variant="filled"
            size="medium"
            iconOnly
            onClick={() => save((objs) => resetPlacement(objs))}
            aria-label="Pack widgets tight, clearing any gaps"
            tooltip="Pack tight — clears the gaps"
          >
            <LayoutGridIcon className="size-4" />
          </Button>
        )}
        <Button
          variant={editing ? "accent" : "filled"}
          size="medium"
          iconOnly
          onClick={() => setEditing((e) => !e)}
          aria-label={editing ? "Done editing widgets" : "Edit widgets"}
        >
          {editing ? <CheckIcon className="size-4" /> : <PencilIcon className="size-4" />}
        </Button>
      </>
    ) : null,
    [hasHome, editing, arranged],
  );

  if (s.stageLoading || !s.stageState) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  const state = s.stageState;
  // Seconds to the service start, for the pre-service window. computePcoTimer
  // already does the skew-corrected maths for both modes, so this reads the
  // countdown it produces rather than parsing targetAt again.
  const timer = computePcoTimer(pcoLive, now, skewMs);
  const secondsToStart = timer?.mode === "preservice" ? timer.seconds : null;
  const mode = homeMode(pcoLiveKnown, pcoLive, secondsToStart);

  // The same view homeView already found — that lookup runs before the loading
  // guard, which is the only reason it needs the optional chaining and this
  // did not. One find(), not two.
  const home = homeView;
  // A Home whose layout was cleared (a hand-edited views.json, a kind change)
  // gets this build's default rather than an editor whose switches do nothing.
  const layout = home?.layout ?? defaultHomeLayout();
  // `pending` is what the operator has done since the last server round-trip.
  // WITHOUT it, every edit was computed from the server's copy, so two changes
  // inside one round-trip both built on the pre-edit array: switching two cards
  // off in quick succession brought the first one back, and a switch followed by
  // a drag moved the wrong card. Cleared when the server's revision advances.
  const objects = pending ?? layout.objects;

  /**
   * Apply a change to the card list and store it.
   *
   * Takes an updater, not a finished array, and applies it to the NEWEST list
   * rather than whatever this render closed over. Two things could make that
   * stale, and both happened:
   *
   *  • across a round-trip — `pending`, the operator's copy, until the server
   *    catches up. Switching two cards off in succession otherwise brought the
   *    first one back, and a switch followed by a drag moved the wrong card.
   *  • within one React batch — `editRef`, written here and never during a
   *    render, because two handlers can both run before anything re-renders.
   *
   * No layoutRev: Home has one editor — this one — so there is nothing to
   * conflict with, and passing a rev would raise a conflict dialog with itself.
   */
  function save(update: (objs: readonly LayoutObject[]) => LayoutObject[]) {
    const next = update(editRef.current ?? objects);
    editRef.current = next;
    setPending(next);
    s.handlers
      .handleSetViewLayout(HOME_VIEW_ID, { ...layout, objects: next })
      // Not a swallowed failure: handleSetViewLayout has already told the
      // operator. This drops the optimistic copy so the page snaps back to what
      // was actually stored, rather than showing an edit that did not land.
      .catch(() => {
        setPending(null);
        editRef.current = null;
      });
  }

  /**
   * The right-click menu for one card.
   *
   * Available WITHOUT entering edit mode, which is the point of it: reaching for
   * seconds on the clock should not mean putting the whole page into an editing
   * state first. Rebuilt on every open so the ticks show the current values.
   *
   * The settings themselves are derived — see card-toggles.
   */
  function cardMenu(card: LayoutObject): ContextMenuItem[] {
    const type = (card.config as { type: string }).type;
    const label = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS]?.label ?? type;
    const toggles = togglesFor(card);
    const items: ContextMenuItem[] = [];

    for (const t of toggles) {
      items.push({
        label: t.label,
        checked: t.checked,
        // A checkable item leaves the menu open, so this fires repeatedly. It is
        // safe to: `card` is the one this render read from the live list, and
        // the next render rebuilds the whole menu from the saved result.
        onSelect: () => save((objs) => replaceCard(objs, withToggle(card, t.key, t.next))),
      });
    }
    // The scores card's "which game", the same choice and the same options the
    // layout inspector offers the wall object. A submenu rather than a row of
    // ticks because the list is as long as the operator's favourites, and it
    // sits with the toggles because it is a setting of the WIDGET, not of the
    // card's place on the page like Size and Show below.
    const pinned = pickedValue(card, "game");
    if (pinned != null) {
      items.push({
        label: "Game",
        items: gameOptions(scoresConfig?.favourites ?? []).map((o) => ({
          label: o.label,
          checked: pinned === o.value,
          onSelect: () => {
            save((objs) => replaceCard(objs, withToggle(card, "game", o.value)));
            setMenu(null);
          },
        })),
      });
    }

    if (items.length) items.push({ separator: true });

    items.push({
      label: "Size",
      items: SIZE_ORDER.map((s) => ({
        label: SIZES[s].label,
        checked: sizeOf(card) === s,
        onSelect: () => {
          save((objs) => setSize(objs, card.id, s as HomeCardSize));
          setMenu(null);
        },
      })),
    });
    items.push({
      label: "Show",
      items: (Object.keys(WHEN_LABELS) as HomeVisibility[]).map((w) => ({
        label: WHEN_LABELS[w],
        checked: whenOf(card) === w,
        onSelect: () => {
          save((objs) => setWhen(objs, card.id, w));
          setMenu(null);
        },
      })),
    });
    items.push({ separator: true });
    items.push({
      label: `Remove ${label}`,
      danger: true,
      onSelect: () => save((objs) => removeCard(objs, card.id)),
    });
    return items;
  }

  // Editing shows EVERY card, including ones whose mood is not the current one —
  // you cannot arrange what the page is hiding from you. Off the editor, Home
  // shows only what belongs to right now, and may draw nothing at all until the
  // live channel has answered: see cardsForNow, which is where that third
  // outcome and the reason it is not a default are written down.
  const cards: LayoutObject[] | null = editing ? objects : cardsForNow(objects, mode);

  // The card the open menu belongs to, read fresh. A card removed from under an
  // open menu closes it rather than leaving a menu of dead actions.
  const menuCard = menu ? (objects.find((o) => o.id === menu.cardId) ?? null) : null;

  /**
   * The grid cell under a pointer.
   *
   * Column and row are read off the grid's own box rather than from the element
   * underneath, so the empty space between and below the cards is a place you
   * can drop into — which is the entire point of being able to leave a gap.
   */
  function cellAt(clientX: number, clientY: number): { col: number; row: number } | null {
    const el = gridEl.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const colW = (r.width - GRID_GAP_PX * (COLUMNS - 1)) / COLUMNS;
    const col = Math.floor((clientX - r.left) / (colW + GRID_GAP_PX)) + 1;
    const row = Math.floor((clientY - r.top) / (ROW_PX + GRID_GAP_PX)) + 1;
    return {
      col: Math.max(1, Math.min(col, COLUMNS)),
      row: Math.max(1, row),
    };
  }

  /** The layout as it would be if the drag landed here — what the page draws
   *  while dragging, so the cards move out of the way before the drop rather
   *  than after it. */
  const previewBoxes: Box[] | undefined = (() => {
    if (!dragId || !dropCell || !cards) return undefined;
    const boxes = boxesOf(cards);
    const moving = boxes.find((b) => b.id === dragId);
    if (!moving) return undefined;
    return pushAway(boxes, {
      ...moving,
      col: clampCol(dropCell.col, moving.w),
      row: dropCell.row,
    });
  })();

  /**
   * Press, move, drop — the whole gesture, in pointer events.
   *
   * A drag only begins once the pointer has actually travelled: the chrome
   * carries the size and remove controls, and a press that never moves has to
   * stay a click on those. The pointer is captured, so a drag that leaves the
   * grid still reports where it went and still ends.
   */
  function startDrag(e: ReactPointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0) return;
    // The chrome carries the size buttons, the visibility select and the remove
    // X. A press on one of those is a press on a CONTROL, and the drag gesture
    // must not touch it — capturing the pointer here retargets the rest of the
    // sequence to the card, so the button never saw its own pointerup and the
    // click never happened. Delete stopped working the day dragging moved to
    // pointer events.
    if ((e.target as HTMLElement).closest("button, select, input, [role='combobox']")) return;

    const el = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!moved) {
        moved = true;
        // Captured only once this IS a drag, for the same reason: until the
        // pointer has travelled, everything under it must keep behaving
        // normally.
        el.setPointerCapture(ev.pointerId);
        setDragId(id);
      }
      const cell = cellAt(ev.clientX, ev.clientY);
      if (cell) setDropCell((prev) => (prev && prev.col === cell.col && prev.row === cell.row ? prev : cell));
    };
    const finish = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", cancel);
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      if (moved) dropOnGrid(id, ev.clientX, ev.clientY);
      else endDrag();
    };
    // A cancelled pointer (a system gesture, a lost capture) must not leave the
    // page frozen mid-drag with a card half-moved.
    const cancel = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", cancel);
      endDrag();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", cancel);
  }

  function endDrag() {
    setDragId(null);
    setDropCell(null);
  }

  /**
   * Drop where the pointer is, gaps and all.
   *
   * The id is an ARGUMENT, not read from state. The gesture's handlers are
   * created on pointerdown, so they close over the render where nothing was
   * being dragged yet — reading `dragId` there gave null, and every drop
   * silently did nothing while the preview had been moving the whole time.
   */
  function dropOnGrid(id: string, clientX: number, clientY: number) {
    const cell = cellAt(clientX, clientY);
    if (cell) save((objs) => placeAt(objs, id, cell.col, cell.row));
    endDrag();
  }


  return (
    <div className="pt-1 pb-[50vh] max-sm:pb-24 flex flex-col gap-3">
      {!state.onboardingDismissed && (
        <GettingStarted
          stageState={state}
          onNavigate={(path: string, flash?: string) => {
            router.navigate({ to: path });
            if (flash) flashTarget(flash);
          }}
          onDismiss={s.handleDismissOnboarding}
        />
      )}

      {home?.layout && cards && (
        <HomeGrid
          layout={{ ...home.layout, objects: cards }}
          cards={cards}
          gridRef={(el) => { gridEl.current = el; }}
          onCardContextMenu={(o, e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, cardId: o.id });
          }}
          boxes={previewBoxes}
          animate={!!dragId}
          chrome={
            editing
              ? (o) => (
                  <CardChrome
                    card={o}
                    dragging={dragId === o.id}
                    onSize={(size) => save((objs) => setSize(objs, o.id, size))}
                    onWhen={(when) => save((objs) => setWhen(objs, o.id, when))}
                    onRemove={() => save((objs) => removeCard(objs, o.id))}
                    onDragPointerDown={(e) => startDrag(e, o.id)}
                  />
                )
              : undefined
          }
        />
      )}

      {menuCard && (
        <ContextMenu x={menu!.x} y={menu!.y} items={cardMenu(menuCard)} onClose={() => setMenu(null)} />
      )}

      <AddWidgetSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={(type, size) => {
          setAdding(false);
          save((objs) => {
            const id = `home-${type}-${objs.length + 1}-${objs.length}`;
            // Below everything on a page that has been arranged, rather than into
            // the first free cell — which is often a gap somebody left on purpose.
            return placeNewCard(setSize(addCard(objs, type, id), id, size), id);
          });
        }}
      />

    </div>
  );
}
