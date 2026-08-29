// Home's widget grid.
//
// Three columns, four preset tile shapes, and no canvas — see home-cards.ts for
// why those four and not a width field.
//
// Every card is drawn by the SHARED renderer (ObjectContent), so a clock on Home
// and a clock on a wall are the same component with the same styling. That is
// what makes "add any widget to Home" a real sentence rather than a promise
// about a second widget set.

import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { LayoutDTO, LayoutObject } from "@main/types/views";

import { ObjectContent, boxStyle, useLayoutData } from "../../main/layout-renderer";
import type { LayoutRenderCtx } from "../../main/layout-renderer";
import { COLUMNS, SIZES, sizeOf } from "./home-cards";
import { boxesOf, rowsNeeded, type Box } from "./home-placement";

/**
 * Slide every card that moved, from where it was to where it now is.
 *
 * Grid lines do not animate — a card that changes cells jumps. This is the
 * standard FLIP: measure before the paint, apply the inverse as a transform so
 * the card appears not to have moved, then release it on the next frame and let
 * a transition carry it across. Without it, "the other widgets move out of the
 * way" is a teleport, which reads as the page glitching rather than as the page
 * making room.
 */
function useSlideOnMove(deps: unknown, enabled: boolean) {
  const host = useRef<HTMLDivElement | null>(null);
  const last = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const cards = [...el.querySelectorAll<HTMLElement>("[data-card-id]")];
    const now = new Map<string, DOMRect>();
    for (const card of cards) {
      const id = card.dataset.cardId!;
      const rect = card.getBoundingClientRect();
      now.set(id, rect);
      const before = last.current.get(id);
      if (!enabled || !before) continue;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      card.style.transition = "none";
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      // Two frames: one to let the browser take the inverted position as the
      // start, one to release it. A single frame is sometimes coalesced with the
      // style write above, and the card jumps anyway.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          card.style.transition = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
          card.style.transform = "";
        });
      });
    }
    last.current = now;
  }, [deps, enabled]);

  // Nothing half-animated survives the end of a drag.
  useEffect(() => {
    if (enabled) return;
    const el = host.current;
    if (!el) return;
    for (const card of el.querySelectorAll<HTMLElement>("[data-card-id]")) {
      card.style.transition = "";
      card.style.transform = "";
    }
  }, [enabled]);

  // A setter rather than the ref itself: the grid also hands its element to the
  // caller, and assigning to a hook's ref from outside it is exactly what the
  // immutability rule is there to stop.
  const setHost = useCallback((el: HTMLDivElement | null) => {
    host.current = el;
  }, []);
  return setHost;
}

/**
 * The widget's own styling MINUS everything Home supplies itself: the frame AND
 * the ground.
 *
 * ON HOME, A WIDGET WEARS HOME'S CARD. A display widget's styling is written for
 * a black wall — a dark ground, a canvas-relative radius, and white text. Every
 * one of those is wrong on an app page that can be light:
 *
 *  - Radius and hairline are fractions of CANVAS height, so two tiles of the
 *    same size came out with different corners: 10.656px against Home's 12px.
 *  - The ground is dark. On a light page that is a black slab in a white grid,
 *    and Home's own cards — which use the app's translucent surface token —
 *    went fully transparent with white text on them, about 1.07:1. Invisible.
 *
 * So Home supplies radius, hairline and ground from the app's card tokens, and
 * the widget supplies its content. Padding, opacity, shadow and alignment are
 * still the object's.
 *
 * Colour that carries STATE still comes through: a recording widget's red is
 * painted by Readout's filled variant, inside the card, not by this background.
 * Colour that is decoration does not survive onto Home — one grid of tiles that
 * reads in both themes beats per-widget tinting that only works in one.
 */
export function cardFrame(o: LayoutObject, H: number): CSSProperties {
  const {
    borderRadius: _fromCanvas,
    border: _alsoFromCanvas,
    background: _writtenForABlackWall,
    ...rest
  } = boxStyle(o, H);
  return rest;
}

/** One grid row, in pixels. Two of these plus a gap is a Large or an XL. */
/**
 * One grid row, in pixels.
 *
 * 120, not 104: a Small tile holds a caption, a value and a sub-line, and at 104
 * the shortest of those — 'SCREENS / 4/5 / one or more offline' — stood 14px
 * proud of its box. A widget cannot scroll and must not clip, so the row is
 * sized to the smallest complete widget rather than the widget trimmed to fit.
 */
export const ROW_PX = 120;

/**
 * The gutter between cards, in px.
 *
 * ONE constant, exported, because two of them existed: the CSS below read a
 * file-local `GAP_PX` while home-route's pointer-to-cell hit-testing imported a
 * separate `GRID_GAP_PX`. They held the same 12 and nothing tied them together,
 * so changing the gutter in one place would have left dropped cards landing in
 * the wrong cell with nothing to show for it.
 */
export const GRID_GAP_PX = 12;

/**
 * The nominal canvas height a Home card's styling is measured against.
 *
 * Every layout style is a fraction of canvas height — a readout's font is 0.06,
 * a card's radius 0.0148 — so Home has to name a height for those fractions to
 * mean anything. Six rows: a default 0.06 readout lands at about a third of a
 * one-row tile, which is the proportion the canvas already produces at a normal
 * dashboard size. The value's own auto-fit takes it from there.
 */
const NOMINAL_H = ROW_PX * 6;

/**
 * The render context, built once for the whole grid.
 *
 * useLayoutData gates its subscriptions on the types actually present in the
 * layout, so a Home with no SPL meter never opens an SPL subscription — the same
 * efficiency rule every other surface follows.
 */
function useHomeCtx(layout: LayoutDTO): LayoutRenderCtx | null {
  const d = useLayoutData(layout);
  // No state yet — the caller renders nothing rather than a grid of dashes.
  if (!d.state) return null;
  // Assembled exactly as LayoutRenderer assembles it — the three renamed fields
  // and the four Home supplies itself. Spelled out rather than spread-and-cast,
  // so a new context field is a compile error here instead of an undefined at
  // runtime on somebody's front page.
  return {
    state: d.state,
    propresenter: d.propresenter,
    propInstances: d.propInstances,
    pcoLive: d.pcoLive,
    planItems: d.planItems,
    transcript: d.transcript,
    spl: d.spl,
    obs: d.obs,
    reaper: d.reaper,
    scores: d.scores,
    resi: d.resi,
    youtube: d.youtube,
    osc: d.osc,
    peopleCount: d.peopleCount,
    serviceLow: d.serviceLow,
    serviceAttendance: d.serviceAttendance,
    servicePeak: d.servicePeaks.occupancy,
    servicePeakAttendance: d.servicePeaks.attendance,
    baptism: d.baptism,
    serviceTimeline: d.serviceTimeline,
    integrations: d.integrationsSnap.states,
    integrationLabels: d.integrationsSnap.labels,
    wireless: d.wireless,
    now: d.now,
    skewMs: d.skewMs,
    ndiSource: null,
    H: NOMINAL_H,
    // Home is the operator's own screen: controls fire and drill-downs work.
    interactive: true,
    // And it IS Home — the flag the streaming cards read to know they are tiles
    // on a page of tiles rather than widgets on a wall.
    home: true,
    placed: undefined,
  };
}

export function HomeGrid({
  layout,
  cards,
  chrome,
  boxes: boxesOverride,
  animate = false,
  gridRef,
  onCardContextMenu,
}: {
  layout: LayoutDTO;
  /** The cards to draw, already filtered and ordered by the caller. */
  cards: readonly LayoutObject[];
  /** Per-card overlay — the editor's controls. Absent when not editing. */
  chrome?: (o: LayoutObject) => ReactNode;
  /** Placements to draw INSTEAD of the stored ones — the live preview of a drag
   *  in progress, so the page shows what dropping here would do. */
  boxes?: readonly Box[];
  /** Slide cards between cells rather than jumping. On during a drag. */
  animate?: boolean;
  /** The grid element itself, for turning a pointer position into a cell. */
  gridRef?: (el: HTMLDivElement | null) => void;
  /** Right-click on a card. On the WRAPPER, not on the widget: a widget is
   *  drawn by the shared renderer and some of them are interactive, so putting
   *  the handler inside would mean each one had to remember to forward it. */
  onCardContextMenu?: (card: LayoutObject, e: ReactMouseEvent) => void;
}) {
  const ctx = useHomeCtx(layout);
  const boxes = boxesOverride ?? boxesOf(cards);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  // A signature rather than the array: the effect must run when a card MOVES,
  // and an array identity changes on every render.
  const signature = boxes.map((b) => `${b.id}:${b.col}:${b.row}`).join("|");
  const setHost = useSlideOnMove(signature, animate);
  if (!ctx) return null;

  return (
    <div
      // NO kiosk-surface. Home is an app page, and its widgets wear the app's
      // colours — see cardFrame below for the whole argument. The class was here
      // to remap foregrounds for display widgets, and remapping them to WHITE on
      // a light page is how Home came out invisible: white text on #f7f8fa, about
      // 1.07:1, over cards that resolved to fully transparent.
      // A CONTAINER query, not a viewport one: Home sits beside the sidebar, so
      // window width is the wrong signal and collapsed the grid to two columns
      // on a laptop that had room for three.
      style={{ containerType: "inline-size", containerName: "home" } as CSSProperties}
    >
      <div
        className="home-grid"
        ref={(el) => {
          setHost(el);
          gridRef?.(el);
        }}
        // Enough rows to reach past the last card, so the empty space below the
        // page is somewhere a widget can actually be dropped. Without it the
        // grid ends at its content and "leave a gap at the bottom" had no
        // surface to land on.
        style={{ gridTemplateRows: `repeat(${rowsNeeded(boxes)}, ${ROW_PX}px)` }}
      >
        {cards.map((o) => {
          const { w, h } = SIZES[sizeOf(o)];
          const box = byId.get(o.id);
          return (
            <div
              key={o.id}
              className="home-card group/card relative min-w-0"
              style={{
                // Explicit cells, so a gap the operator left stays a gap. The
                // narrow breakpoints below throw both away and let it flow —
                // a column chosen on a three-wide page is not a column on a
                // phone.
                gridColumn: box ? `${box.col} / span ${w}` : `span ${w}`,
                gridRow: box ? `${box.row} / span ${h}` : `span ${h}`,
                ["--card-w" as string]: String(w),
                ["--card-h" as string]: String(h),
              }}
              data-card-id={o.id}
              onContextMenu={onCardContextMenu ? (e) => onCardContextMenu(o, e) : undefined}
            >
              {/* boxStyle is what paints the widget's own frame — background,
                  hairline, radius, padding. On a canvas the object wrapper
                  applies it; rendering ObjectContent alone left every Home card
                  transparent and edge-to-edge, which read as "the card look did
                  not ship" rather than "Home forgot the box".

                  The FRAME comes from Home, not from the object. Radius and
                  border width on a canvas are fractions of canvas height, so a
                  widget landed at 10.66px radius and a 0.08 hairline while
                  Home's own cards used the app's 12px and 0.09 — measured, and
                  visible as tiles whose edges do not agree. Colour still comes
                  from the object, so a red-preset widget stays red. */}
              <div
                className="rounded-xl border border-line bg-surface"
                style={{ ...cardFrame(o, NOMINAL_H), width: "100%", height: "100%", overflow: "hidden" }}
              >
                <ObjectContent o={o} ctx={ctx} />
              </div>
              {chrome?.(o)}
            </div>
          );
        })}
      </div>
      <style>{`
        /* A widget is a fixed box. It does not scroll — a tile you can scroll
           is a panel, and a dashboard you have to scroll inside to read is not a
           glance. Content that does not fit is the WIDGET's problem to solve at
           that size, not the grid's to paper over. */
        .home-grid {
          display: grid;
          grid-template-columns: repeat(${COLUMNS}, minmax(0, 1fr));
          grid-auto-rows: ${ROW_PX}px;
          gap: ${GRID_GAP_PX}px;
          /* A Small drops into the gap a Large leaves beside it. Still here for
             a card with no placement of its own — the placements above are
             resolved before this ever sees them. */
          grid-auto-flow: row dense;
        }
        @container home (max-width: 520px) {
          /* A widget is a fixed box. It does not scroll — a tile you can scroll
           is a panel, and a dashboard you have to scroll inside to read is not a
           glance. Content that does not fit is the WIDGET's problem to solve at
           that size, not the grid's to paper over. */
        .home-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            /* Placements are for the full-width page. Here the rows are whatever
               the flow makes them. */
            grid-template-rows: none !important;
          }
          .home-card {
            grid-column: span 2 !important;
            grid-row: span var(--card-h, 1) !important;
          }
        }
        @container home (max-width: 340px) {
          /* A widget is a fixed box. It does not scroll — a tile you can scroll
           is a panel, and a dashboard you have to scroll inside to read is not a
           glance. Content that does not fit is the WIDGET's problem to solve at
           that size, not the grid's to paper over. */
        .home-grid {
            grid-template-columns: minmax(0, 1fr);
            grid-template-rows: none !important;
          }
          .home-card {
            grid-column: span 1 !important;
            grid-row: span var(--card-h, 1) !important;
          }
        }
      `}</style>
    </div>
  );
}
