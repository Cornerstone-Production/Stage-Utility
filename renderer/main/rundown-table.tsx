import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PcoItemTypeColor } from "../../main/types/stage.js";
import { resolveItemColour } from "./item-colour";
import { headerColoursFor } from "./category-header-colour";

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
// Row colour has ONE source: PCO's item row colours. There is deliberately no
// per-category accent — PCO has no colour for a note category (item_note_categories
// carries only name/sequence/frequently_used), so any category colour would have been
// invented here rather than read from the plan.

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
  footer,
  autoScroll = true,
  textSizeClass = "text-[clamp(0.8rem,1.6vmin,1.1rem)]",
}: {
  items: PlanItemDTO[];
  columns: RundownColumn[];
  currentItemId?: string | null;
  /** Tint a row when this note category has content for the item (department focus). */
  /** PCO's item row colours for this service type (see item-colour.ts). */
  itemTypeColors?: PcoItemTypeColor[];
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
  // No page max-width anywhere: a centred column leaves dead margins on a stage panel
  // and shrinks the text relative to the viewport. The SHAPE changes instead.
  const shape = width < 640 ? "stacked" : width < 1024 ? "compact" : "full";
  // Compact drops the clock (a projected time, the least load-bearing column) before
  // it touches anything an operator reads off the page.
  const shownColumns = shape === "full" ? columns : columns.filter((c) => c.key !== "clock");
  // Spread across the columns this layout actually shows, so they are always maximally
  // distinct from each other — see category-header-colour.ts.
  const headerColours = useMemo(
    () => headerColoursFor(shownColumns.map((c) => c.key)),
    [shownColumns],
  );
  useEffect(() => {
    if (autoScroll) currentRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentItemId, autoScroll]);

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
          const rowColour = isCurrent ? null : resolveItemColour(it, itemTypeColors);
          return (
            <div
              key={it.id}
              ref={isCurrent ? (currentRef as unknown as React.Ref<HTMLDivElement>) : undefined}
              className={`flex flex-col gap-0.5 border-b border-line px-3 py-2 ${isCurrent ? "bg-live-9/10" : ""}`}
              style={rowColour ? {
                background: `color-mix(in srgb, ${rowColour} 10%, transparent)`,
                boxShadow: `inset 3px 0 0 0 ${rowColour}`,
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
                    <span
                      className="shrink-0 text-fg-subtle"
                      style={headerColours[c.key] ? { color: headerColours[c.key] } : undefined}
                    >
                      {c.header}
                    </span>
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
    <div ref={wrapRef}>
    <table className={`w-full border-collapse ${textSizeClass}`}>
      <thead className="sticky top-0 z-10 bg-[var(--kiosk-surface-1)] text-fg-subtle">
        <tr className="text-left">
          {shownColumns.map((c) => {
            // Each note column's header carries its own colour so a layout's columns
            // are told apart at a glance. Structural columns (Clock/Time/Item) stay
            // default — see category-header-colour.ts.
            const tint = headerColours[c.key];
            return (
              <th
                key={c.key}
                className={`px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.headerClassName ?? ""}`}
                style={{ ...(c.width ? { width: c.width } : {}), ...(tint ? { color: tint } : {}) }}
              >
                {c.header}
              </th>
            );
          })}
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
          // A live item outranks PCO's colour — a running item must stay the most
          // prominent row on the page.
          const rowColour = isCurrent ? null : resolveItemColour(it, itemTypeColors);
          return (
            <tr
              key={it.id}
              ref={isCurrent ? currentRef : undefined}
              className={`border-b border-line align-top ${isCurrent ? "bg-live-9/10" : ""}`}
              // Stripe carries the hue at full strength (legible at distance); the
              // wash groups the row without lifting the background into the text.
              // PCO's palette is authored for a white table, so both are needed.
              style={rowColour ? {
                background: `color-mix(in srgb, ${rowColour} 10%, transparent)`,
                boxShadow: `inset 3px 0 0 0 ${rowColour}`,
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
