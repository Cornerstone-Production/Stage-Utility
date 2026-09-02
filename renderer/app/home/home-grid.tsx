// Home's widget grid.
//
// Three columns, four preset tile shapes, and no canvas — see home-cards.ts for
// why those four and not a width field.
//
// Every card is drawn by the SHARED renderer (ObjectContent), so a clock on Home
// and a clock on a wall are the same component with the same styling. That is
// what makes "add any widget to Home" a real sentence rather than a promise
// about a second widget set.

import { type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { LayoutDTO, LayoutObject } from "@main/types/views";
import { HOME_VIEW_ID } from "@main/services/home-view";

import { ObjectContent, boxStyle, useLayoutData } from "../../main/layout-renderer";
import type { LayoutRenderCtx } from "../../main/layout-renderer";
import { COLUMNS, SIZES, sizeOf } from "./home-cards";
import { boxesOf, rowsNeeded, type Box } from "./home-placement";
import { useSlideOnMove } from "../../lib/use-slide-on-move";

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
 *
 * Subtracts, with ONE addition: `position: relative`, which is what makes
 * "inside the card" true rather than aspirational. See the note on it below.
 */
export function cardFrame(o: LayoutObject, H: number): CSSProperties {
  const {
    borderRadius: _fromCanvas,
    border: _alsoFromCanvas,
    background: _writtenForABlackWall,
    ...rest
  } = boxStyle(o, H);
  // POSITIONED, so that "inside the card" above is true rather than aspirational.
  //
  // Readout lays its whole composition out `position: absolute; inset: 0`, and
  // paints the filled ground inset:0 inside THAT — so the pair reach whatever
  // box the composition resolves against, which is the nearest POSITIONED
  // ancestor. On a canvas that is the object's own wrapper, so the ground lands
  // in the wrapper's PADDING box and the card's hairline stays drawn outside it.
  //
  // This frame was static, so on Home the composition resolved against the grid
  // cell OUTSIDE it — the frame's BORDER box — and the ground covered the
  // border on all four sides: a recording widget lost the edge its unfilled
  // neighbour in the next tile still had. Measured in a browser: frame and
  // ground both 437x120 at the same origin, against 435x118 after this.
  //
  // The frame's own `overflow: hidden` did not save it. An absolutely positioned
  // element whose containing block is an ANCESTOR of the clipping box is not
  // clipped by it.
  //
  // Every child of the frame moves, not only the filled ones — an unfilled
  // composition was simply overlapping a 1px border invisibly.
  //
  // Home's OWN cards get this from a Tailwind class instead — see STAT_CARD in
  // cards.tsx, whose comment says the same thing. It is an inline style here
  // because that is the half a test can read: jsdom loads no stylesheet, so a
  // `relative` in the className resolves to "static" and a containing-block
  // guard over it would pass on the bug.
  return { ...rest, position: "relative" };
}

/**
 * The element a Home widget's card is drawn on, and the containing block for
 * everything the widget draws inside it.
 *
 * A component rather than a div spelled out in the grid, so the guard in
 * card-frame-containing-block.test.tsx renders the REAL frame. Written inline,
 * the only thing tying `cardFrame` to the element that needs it was a spread
 * somebody could drop with every test still green.
 *
 * boxStyle is what paints a widget's frame — background, hairline, radius. On a
 * canvas the object wrapper applies it; rendering ObjectContent alone left every
 * Home card transparent and edge-to-edge, which read as "the card look did not
 * ship" rather than "Home forgot the box".
 *
 * The FRAME itself comes from Home, not from the object. Radius and border width
 * on a canvas are fractions of canvas height, so a widget landed at 10.66px
 * radius and a 0.08 hairline while Home's own cards used the app's 12px and
 * 0.09 — measured, and visible as tiles whose edges do not agree. Colour still
 * comes from the object, so a red-preset widget stays red.
 */
export function CardFrame({ o, children }: { o: LayoutObject; children: ReactNode }) {
  return (
    <div
      className="rounded-xl border border-line bg-surface"
      style={{ ...cardFrame(o, NOMINAL_H), width: "100%", height: "100%", overflow: "hidden" }}
    >
      {children}
    </div>
  );
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
function useHomeCtx(layout: LayoutDTO, menuCardId: string | null): LayoutRenderCtx | null {
  // HOME_VIEW_ID, matching `embedChain` below: the gate walks embedded layouts
  // under the same cycle/depth limiter the renderer uses, so seeding it with
  // nothing would give the gate one more level of budget than the render and
  // subscribe for a tile Home refuses to draw.
  const d = useLayoutData(layout, HOME_VIEW_ID);
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
    pvp: d.pvp,
    pvpSkewMs: d.pvpSkewMs,
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
    // Real presence, from the heartbeat — Home's screens count and its readiness
    // list are two of the three things in the app that draw it.
    onlineOutputIds: d.onlineOutputIds,
    now: d.now,
    skewMs: d.skewMs,
    ndiSource: null,
    H: NOMINAL_H,
    // Home is the operator's own screen: controls fire and drill-downs work.
    interactive: true,
    // And it IS Home — the flag the streaming cards read to know they are tiles
    // on a page of tiles rather than widgets on a wall.
    home: true,
    // Home IS the outermost view, so it is ON the chain rather than absent from
    // it: a card embedding Home would otherwise draw a second Home inside itself
    // and only the depth cap would stop it.
    embedChain: [HOME_VIEW_ID],
    // Home is a page of tiles, not a tile inside somebody else's, so a card that
    // embeds a view carries its own expand control.
    insideEmbedTile: false,
    placed: undefined,
    // The one caller that actually populates this — see LayoutRenderCtx. Read
    // by a card's own chart to stop tracking the pointer under the menu that
    // right-clicking that same card just opened.
    activeCardMenuId: menuCardId,
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
  menuCardId = null,
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
  /** The id of the card whose menu `onCardContextMenu` opened, so its own
   *  widget can be told to stop tracking the pointer under it. The caller owns
   *  the menu's whole lifecycle (position, items, close) — this is only the
   *  one bit of that state a widget underneath needs to see. */
  menuCardId?: string | null;
}) {
  const ctx = useHomeCtx(layout, menuCardId);
  const boxes = boxesOverride ?? boxesOf(cards);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  // A signature rather than the array: the effect must run when a card MOVES,
  // and an array identity changes on every render.
  const signature = boxes.map((b) => `${b.id}:${b.col}:${b.row}`).join("|");
  const { setHost } = useSlideOnMove(signature, animate);
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
              <CardFrame o={o}>
                <ObjectContent o={o} ctx={ctx} />
              </CardFrame>
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
