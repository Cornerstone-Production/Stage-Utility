import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { clamp } from "@main/services/clamp";
import { useResyncOn } from "../lib/use-resync-on";
import type { PcoItemTypeColor } from "../../main/types/stage.js";
import { resolveItemColor, mapPcoColor, washFor, stripeFor } from "./item-color";
import { categoryColor } from "./category-color";
import { resolveRole } from "./role-resolve";
import type { CategoryRole } from "../../main/types/scriptview-roles.js";

// Shared PCO plan rundown table. Both the "script" View-kind (ScriptView on a
// display) and the standalone ScriptView pages render through this so column
// behavior, section-header rows, live-item highlight, and auto-scroll live in
// one place. Callers supply the column spec; this owns the row structure.

/** SERVICE START / END headers get a stronger band than ordinary section rows.
 *  Mirrors the server-side detection in pco-service (kept loose on purpose). */
export function rundownHeaderKind(title: string): "start" | "end" | null {
  const t = title.trim().toUpperCase();
  if (/\bSERVICE\s+(START|BEGIN)\b|\bSTART OF SERVICE\b/.test(t)) return "start";
  if (/\bSERVICE\s+(END|DISMISS)\b|\bEND OF SERVICE\b/.test(t)) return "end";
  return null;
}

// Department → accent hue for row tinting. Keyword-matched (categories are named
// freely per org) with a NEUTRAL fallback, drawn from the same palette the patch
// sheet offers (patch-device-manager PATCH_COLORS) so departments and devices read
// as one system. Hues are spread amber/green/blue/teal/red for separation at the
// 12%-alpha tint these are used at; no purple or magenta, per the palette rule.
// Must stay 6-digit hex — callers concatenate an alpha suffix (`${color}1f`).
// Row color has ONE source: PCO's item row colors. There is deliberately no
// per-category accent — PCO has no color for a note category (item_note_categories
// carries only name/sequence/frequently_used), so any category color would have been
// invented here rather than read from the plan.

/** Below this the rows stop being readable, and a scrollbar is the lesser evil. */
const MIN_FIT_SCALE = 0.55;
/**
 * Aim a half-percent inside the box rather than exactly at its edge.
 *
 * Cell padding is `px-3` — rem-based, so it does NOT shrink with the type, and
 * the natural width back-derived from the scroll width therefore overstates how
 * much scaling actually buys. Landing exactly on the edge left ~9px of a 1920px
 * table outside the box, which is a horizontal scrollbar for nine pixels: the
 * whole defect, in miniature. Undershooting costs nothing visible.
 */
const FIT_UNDERSHOOT = 0.995;

/**
 * One step of the width fit: the scale to render at next, given what the last
 * render measured. Returns `scale` unchanged when there is nothing to do.
 *
 * Pure, and separated from the hook, because the subtle part is not the DOM work
 * — it is that the step must STRICTLY DECREASE or stop. A draft that applied the
 * undershoot unconditionally made a table that already fit measure 0.995 of
 * itself every pass, so it ratcheted down for ever and the no-op case quietly
 * became a shrink. That is invisible in a screenshot and obvious in a test.
 */
export function nextFitScale(
  { availW, scrollW, scale }: { availW: number; scrollW: number; scale: number },
): number {
  if (availW <= 1) return scale;
  // Fits (within a pixel of rounding): the only exit, and the reason the
  // standalone page with a handful of columns is untouched by any of this.
  if (scrollW <= availW + 1) return scale;
  const natural = scrollW / scale;
  if (natural <= 0) return scale;
  const desired = clamp((availW / natural) * FIT_UNDERSHOOT, MIN_FIT_SCALE, 1);
  return desired < scale - 0.002 ? desired : scale;
}

/**
 * Shrink the rundown's type until the columns fit the box left-to-right.
 *
 * A `w-full` table still lays out `table-layout: auto`, which cannot go narrower
 * than its columns' min-content width — so past a certain column count it
 * overflows however wide the box is. Tailwind's `overflow-y-auto` leaves
 * `overflow-x: visible`, which CSS then COMPUTES to `auto`, so the overflow
 * showed up as a horizontal scrollbar on a stage display: the last department
 * columns simply were not on screen, and nobody scrolls a wall monitor.
 *
 * Fitting the type rather than the columns is deliberate. `table-layout: fixed`
 * would also guarantee the fit, but it hands every column an equal share of the
 * leftover, so the Item column — titles, key/BPM, and the description — would get
 * the same width as "Video". Auto layout's content-proportional sizing is what
 * makes the rundown readable; this keeps it and scales the whole thing down.
 *
 * The base size is MEASURED, never assumed, because the two surfaces set it
 * differently: the page through a viewport clamp on the table, an embedded view
 * through an inherited font-size on its wrapper. Measuring means this is a no-op
 * — no inline size at all — whenever the table already fits, so the standalone
 * page with a handful of columns renders exactly as it did before.
 *
 * Back-derives the natural width from the live scroll width, the same approach as
 * FitText and ServiceOrderObject's auto-fit.
 */
function useFitWidth(wrapRef: React.RefObject<HTMLDivElement | null>, width: number, deps: unknown[]): number {
  const [scale, setScale] = useState(1);

  // Start every fit from unscaled. A `w-full` table always fills its box, so once
  // it fits there is NO slack left to measure — nothing would ever tell the fit it
  // could grow back, and a scale chosen for a narrow settings preview would stick
  // for ever after the box got wider. Resetting on change is what makes it
  // reversible without needing to detect slack that does not exist.
  //
  // During render, not in an effect: an effect would paint one frame at the old
  // scale before correcting, which on a stage display is the rundown visibly
  // jumping size on every resize.
  useResyncOn([width, ...deps], () => setScale(1));

  // Shrink one step per render, and only ever DOWNWARD. An earlier draft let the
  // scale move either way and applied the undershoot unconditionally — so a table
  // that already fit still measured 0.995 of itself every pass and ratcheted down
  // for ever, quietly turning the no-op case into a 4% shrink. Monotone descent
  // from a known start cannot oscillate: it stops when the table fits, or at the
  // floor.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const next = nextFitScale({ availW: wrap.clientWidth, scrollW: wrap.scrollWidth, scale });
    if (next !== scale) setScale(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapRef, scale, width, ...deps]);

  return scale;
}

/** The nearest ancestor that actually scrolls vertically, or null. */
export function nearestScroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight <= p.clientHeight) continue;
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return p;
  }
  return null;
}

/**
 * Centre a row in its own scroll container, and move nothing else.
 *
 * `Element.scrollIntoView` adjusts EVERY scrollable ancestor, which is fine on a
 * page that owns the screen and wrong inside a layout object: an embedded rundown
 * scrolling itself would also scroll the page around it. Computing the offset
 * against one container keeps the effect where it belongs.
 *
 * Exported for the guard — the arithmetic is the part worth pinning.
 */
export function rowScrollTop(rowTop: number, rowHeight: number, scrollerTop: number, scrollerScrollTop: number, scrollerHeight: number): number {
  const offsetWithin = rowTop - scrollerTop + scrollerScrollTop;
  return Math.max(0, offsetWithin - (scrollerHeight - rowHeight) / 2);
}

function scrollRowIntoView(row: HTMLElement): void {
  const scroller = nearestScroller(row);
  if (!scroller) return;
  const r = row.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const top = rowScrollTop(r.top, r.height, s.top, scroller.scrollTop, scroller.clientHeight);
  scroller.scrollTo({ top, behavior: "smooth" });
}

export interface RundownColumn {
  key: string;
  header: string;
  align?: "left" | "right";
  /** CSS width (e.g. "4rem"). */
  width?: string;
  headerClassName?: string;
  cellClassName?: string;
  render: (item: PlanItemDTO, ctx: { isCurrent: boolean }) => ReactNode;
}

export function RundownTable({
  items,
  columns,
  currentItemId,
  itemTypeColors,
  rowColor,
  accentRole,
  roles,
  footer,
  autoScroll = true,
  textSizeClass = "text-[clamp(0.8rem,1.6vmin,1.1rem)]",
}: {
  items: PlanItemDTO[];
  columns: RundownColumn[];
  currentItemId?: string | null;
  /** Tint a row when this note category has content for the item (department focus). */
  /** PCO's item row colors for this service type (see item-color.ts). */
  itemTypeColors?: PcoItemTypeColor[];
  /** What colors this layout's rows. Absent = "pco". */
  rowColor?: "pco" | "category" | "none";
  /** Role whose presence tints a row, when rowColor === "category". */
  accentRole?: string | null;
  /** Category roles, needed to resolve accentRole against this item's notes. */
  roles?: CategoryRole[];
  /** Optional sticky bottom band (e.g. total time), spanning all columns. */
  footer?: import("react").ReactNode;
  autoScroll?: boolean;
  textSizeClass?: string;
}) {
  const currentRef = useRef<HTMLTableRowElement | null>(null);

  // Measured on the table's own wrapper, not the viewport: this also renders inside
  // the settings live preview, which is a narrow container on a wide screen — a
  // viewport media query would get that case exactly backwards.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1280);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // No page max-width anywhere: a centerd column leaves dead margins on a stage panel
  // and shrinks the text relative to the viewport. The SHAPE changes instead.
  const shape = width < 640 ? "stacked" : width < 1024 ? "compact" : "full";
  // Re-fit whenever the column set or the row content changes: both move the
  // natural width, and neither is a resize the observer would see.
  const fitScale = useFitWidth(wrapRef, width, [shape, columns.length, items.length, textSizeClass]);
  // Compact drops the clock (a projected time, the least load-bearing column) before
  // it touches anything an operator reads off the page.
  const shownColumns = shape === "full" ? columns : columns.filter((c) => c.key !== "clock");

  const source = rowColor ?? "pco";
  /** The color for one row, from whichever source this layout selected. */
  const tintFor = (it: PlanItemDTO): string | null => {
    if (source === "none") return null;
    if (source === "category") {
      // Tinted only where this layout's role actually has something to say — resolved
      // through the role so it works whatever this service type calls the category.
      const role = roles?.find((r) => r.id === accentRole);
      if (!role || !resolveRole(role, it.notesByCategory)) return null;
      return categoryColor(role.name);
    }
    const pco = resolveItemColor(it, itemTypeColors);
    return pco ? mapPcoColor(pco) : null;
  };
  // Keep the live item in view. Two things here are deliberate.
  //
  // `items` is in the deps, not just `currentItemId`. The rundown arrives from
  // the server after mount, so opening a display DURING a service had the live id
  // already set and unchanged by the time the rows existed — the effect had
  // already run against an empty table, found no row, and never fired again. The
  // display then sat on the top of the plan for the whole service, which is
  // exactly the case auto-scroll exists for.
  //
  // And it scrolls the rundown's OWN scroller rather than calling
  // scrollIntoView, which walks every scrollable ancestor. On the standalone page
  // nothing above it scrolls so the difference never showed; embedded in a
  // layout it can drag the whole page, moving objects that have nothing to do
  // with the rundown.
  useEffect(() => {
    if (!autoScroll) return;
    const row = currentRef.current;
    if (!row) return;
    scrollRowIntoView(row);
  }, [currentItemId, autoScroll, items]);

  if (shape === "stacked") {
    return (
      <div ref={wrapRef} className={`flex flex-col ${textSizeClass}`}>
        {items.map((it) => {
          const isCurrent = currentItemId != null && currentItemId === it.id;
          if (it.itemType === "header") {
            const kind = rundownHeaderKind(it.title);
            return (
              <div
                key={it.id}
                className={`px-3 py-1.5 text-caption1 font-semibold uppercase tracking-wider ${kind ? "bg-white/[0.1] text-fg" : "bg-white/[0.06] text-fg-muted"}`}
              >
                {it.title}
              </div>
            );
          }
          const rowTint = isCurrent ? null : tintFor(it);
          return (
            <div
              key={it.id}
              ref={isCurrent ? (currentRef as unknown as React.Ref<HTMLDivElement>) : undefined}
              className={`flex flex-col gap-0.5 border-b border-line px-3 py-2 ${isCurrent ? "bg-live-9/10" : ""}`}
              style={rowTint ? {
                background: washFor(rowTint),
                boxShadow: `inset 3px 0 0 0 ${stripeFor(rowTint)}`,
              } : undefined}
            >
              {shownColumns.map((c) => {
                const body = c.render(it, { isCurrent });
                if (body == null || body === "") return null;
                // Every column keeps its header as a label, since the columns are gone.
                return c.key === "title" ? (
                  <div key={c.key} className="font-medium">{body}</div>
                ) : (
                  <div key={c.key} className="flex gap-1.5 text-caption2">
                    <span className="shrink-0 text-fg-subtle">{c.header}</span>
                    <span className="min-w-0 whitespace-pre-line text-fg-muted">{body}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {footer && <div className="px-3 py-2 text-caption1 text-fg-muted">{footer}</div>}
      </div>
    );
  }

  return (
    // The size lives on the WRAPPER so the table can express its fit as a plain
    // percentage of it. Setting an inline px size on the table instead would mean
    // measuring the class's computed size first and re-deriving it on every
    // resize; a percentage resolves against the inherited size by itself, and is
    // exactly a no-op at scale 1.
    <div ref={wrapRef} className={textSizeClass}>
    <table className="w-full border-collapse" style={{ fontSize: `${fitScale * 100}%` }}>
      <thead className="sticky top-0 z-10 bg-[var(--kiosk-surface-1)] text-fg-subtle">
        <tr className="text-left">
          {shownColumns.map((c) => (
            <th
              key={c.key}
              className={`px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.headerClassName ?? ""}`}
              style={c.width ? { width: c.width } : undefined}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          if (it.itemType === "header") {
            const kind = rundownHeaderKind(it.title);
            return (
              <tr key={it.id} className={kind ? "bg-white/[0.1]" : "bg-white/[0.06]"}>
                <td
                  colSpan={shownColumns.length}
                  className={`px-3 py-1.5 text-caption1 font-semibold uppercase tracking-wider ${kind ? "text-fg" : "text-fg-muted"}`}
                >
                  {it.title}
                </td>
              </tr>
            );
          }
          const isCurrent = currentItemId != null && currentItemId === it.id;
          // Row tint when the accent department has content here (not while the
          // live-item highlight already owns the row).
          // ONE source per row, chosen by the layout — never both. A row carrying two
          // colors is more information than a line on a stage display can hold.
          // A live item outranks either: a running item stays the most prominent row.
          const rowTint = isCurrent ? null : tintFor(it);
          return (
            <tr
              key={it.id}
              ref={isCurrent ? currentRef : undefined}
              className={`border-b border-line align-top ${isCurrent ? "bg-live-9/10" : ""}`}
              // Stripe carries the hue at full strength (legible at distance); the
              // wash groups the row without lifting the background into the text.
              // PCO's palette is authored for a white table, so both are needed.
              style={rowTint ? {
                background: washFor(rowTint),
                boxShadow: `inset 3px 0 0 0 ${stripeFor(rowTint)}`,
              } : undefined}
            >
              {shownColumns.map((c) => (
                <td
                  key={c.key}
                  className={`px-3 py-2 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.cellClassName ?? ""}`}
                >
                  {c.render(it, { isCurrent })}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
      {footer != null && (
        <tfoot className="sticky bottom-0 z-10 bg-[var(--kiosk-surface-1)]">
          <tr>
            <td colSpan={columns.length} className="px-3 py-2 border-t border-line text-caption1 font-semibold uppercase tracking-wider text-fg-muted">
              {footer}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
    </div>
  );
}
