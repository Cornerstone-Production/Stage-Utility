// Home's widget grid.
//
// Three columns, four preset tile shapes, and no canvas — see home-cards.ts for
// why those four and not a width field.
//
// Every card is drawn by the SHARED renderer (ObjectContent), so a clock on Home
// and a clock on a wall are the same component with the same styling. That is
// what makes "add any widget to Home" a real sentence rather than a promise
// about a second widget set.

import type { CSSProperties, ReactNode } from "react";
import type { LayoutDTO, LayoutObject } from "@main/types/views";

import { ObjectContent, boxStyle, useLayoutData } from "../../main/layout-renderer";
import type { LayoutRenderCtx } from "../../main/layout-renderer";
import { SIZES, sizeOf } from "./home-cards";

/** One grid row, in pixels. Two of these plus a gap is a Large or an XL. */
export const ROW_PX = 104;
const GAP_PX = 12;

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
    placed: undefined,
    canvasBg: null,
  };
}

export function HomeGrid({
  layout,
  cards,
  chrome,
}: {
  layout: LayoutDTO;
  /** The cards to draw, already filtered and ordered by the caller. */
  cards: readonly LayoutObject[];
  /** Per-card overlay — the editor's controls. Absent when not editing. */
  chrome?: (o: LayoutObject) => ReactNode;
}) {
  const ctx = useHomeCtx(layout);
  if (!ctx) return null;

  return (
    <div
      // kiosk-surface, because these are DISPLAY widgets. Their styling is built
      // for a black wall — white text on a 4%-white card — and on a themed app
      // page that came out black-on-black in dark mode and white-on-white in
      // light, where a clock was literally invisible. This class already exists
      // for exactly that problem (see its comment in styles.css: "measured at
      // 1.14:1"), and it makes Home's grid show what a screen would show.
      className="kiosk-surface rounded-xl p-3"
      // A CONTAINER query, not a viewport one: Home sits beside the sidebar, so
      // window width is the wrong signal and collapsed the grid to two columns
      // on a laptop that had room for three.
      style={{ containerType: "inline-size", containerName: "home" } as CSSProperties}
    >
      <div className="home-grid">
        {cards.map((o) => {
          const { w, h } = SIZES[sizeOf(o)];
          return (
            <div
              key={o.id}
              className="home-card group/card relative min-w-0"
              style={{ gridColumn: `span ${w}`, gridRow: `span ${h}` }}
              data-card-id={o.id}
            >
              {/* boxStyle is what paints the widget's own frame — background,
                  hairline, radius, padding. On a canvas the object wrapper
                  applies it; rendering ObjectContent alone left every Home card
                  transparent and edge-to-edge, which read as "the card look did
                  not ship" rather than "Home forgot the box". */}
              <div style={{ ...boxStyle(o, NOMINAL_H), width: "100%", height: "100%", overflow: "hidden" }}>
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
          grid-template-columns: repeat(3, minmax(0, 1fr));
          grid-auto-rows: ${ROW_PX}px;
          gap: ${GAP_PX}px;
          /* A Small drops into the gap a Large leaves beside it. */
          grid-auto-flow: row dense;
        }
        @container home (max-width: 520px) {
          /* A widget is a fixed box. It does not scroll — a tile you can scroll
           is a panel, and a dashboard you have to scroll inside to read is not a
           glance. Content that does not fit is the WIDGET's problem to solve at
           that size, not the grid's to paper over. */
        .home-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .home-card { grid-column: span 2 !important; }
        }
        @container home (max-width: 340px) {
          /* A widget is a fixed box. It does not scroll — a tile you can scroll
           is a panel, and a dashboard you have to scroll inside to read is not a
           glance. Content that does not fit is the WIDGET's problem to solve at
           that size, not the grid's to paper over. */
        .home-grid { grid-template-columns: minmax(0, 1fr); }
          .home-card { grid-column: span 1 !important; }
        }
      `}</style>
    </div>
  );
}
