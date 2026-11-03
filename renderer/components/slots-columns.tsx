import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { SlotPanel } from "./slot-panel";

/**
 * The columns a slot list draws: board order, a slot stacked on the previous one
 * joining that slot's column. ONE rule, here, because the kiosk draws it and the
 * Mic slots page edits it — a second copy would let the editor's idea of a column
 * and the screen's drift apart.
 */
export function groupColumns(slots: readonly Slot[]): Slot[][] {
  const sorted = [...slots].sort((a, b) => a.order - b.order);
  const columns: Slot[][] = [];
  for (const slot of sorted) {
    if (slot.stackWithPrevious && columns.length > 0) columns[columns.length - 1].push(slot);
    else columns.push([slot]);
  }
  return columns;
}

/** A column that is only spacers: a gap for charger alignment, drawn as nothing. */
export const isSpacerColumn = (col: readonly Slot[]) => col.every((s) => s.link.kind === "spacer");

/**
 * Hooks the Mic slots page uses to draw its editing affordances over the same
 * columns the kiosk draws. Absent, SlotsColumns is exactly the kiosk's.
 *
 * Every hook adds to a column without changing its box: `gap` is a zero-width
 * item, and the others wrap what the kiosk would have drawn in place.
 */
export interface SlotsColumnsEditing {
  /** Drawn before column `index`, and once more after the last (index === columns). */
  gap: (index: number) => ReactNode;
  /** A column's contents: `cards` are the panels the kiosk would draw, in order. */
  column: (column: Slot[], index: number, cards: ReactNode[]) => ReactNode;
  /** One slot's panel, wrapped. */
  card: (slot: Slot, panel: ReactNode) => ReactNode;
  /** A spacer column. The kiosk draws nothing there. */
  spacer: (column: Slot[], index: number) => ReactNode;
}

/**
 * The kiosk's fill-height mic-slot columns. Stacked slots share a column. With a
 * `slotsLayout`, columns are sized in inches against the monitor's active width
 * and centered so they line up with the physical chargers; otherwise they share
 * width equally. Shared by the standalone slots view (stage-view.tsx), the
 * embedded "Mic slots" object in custom layouts (layout-renderer.tsx) and the Mic
 * slots page's previews, so all three render identically.
 */
export function SlotsColumns({
  slots,
  slotsLayout,
  emptySlotLogo,
  defaultAvatar,
  className,
  editing,
}: {
  slots: Slot[];
  slotsLayout: SlotsLayout | null;
  emptySlotLogo: string | null;
  defaultAvatar?: string | null;
  className?: string;
  /** The Mic slots page's editing layer. Never set on a screen. */
  editing?: SlotsColumnsEditing;
}) {
  const columns = groupColumns(slots);

  const columnFlex = (col: Slot[]): string | undefined => {
    if (!slotsLayout || slotsLayout.displayWidthIn <= 0) return undefined;
    const inches = col[0]?.widthIn ?? slotsLayout.columnWidthIn;
    return `0 0 ${(inches / slotsLayout.displayWidthIn) * 100}%`;
  };

  return (
    <div className={cn("flex min-h-0", slotsLayout && "justify-center", className)}>
      {columns.map((column, ci) => {
        const flex = columnFlex(column);
        const spacer = isSpacerColumn(column);
        // A spacer is a gap for charger alignment and nothing else — it used to
        // be able to hold the empty-slot logo, which was never used.
        const cards = spacer
          ? []
          : column.map((slot) => {
              const panel = <SlotPanel key={slot.id} slot={slot} emptySlotLogo={emptySlotLogo} defaultAvatar={defaultAvatar} />;
              return editing ? (
                <div key={slot.id} className="flex min-h-0 flex-1 flex-col">
                  {editing.card(slot, panel)}
                </div>
              ) : (
                panel
              );
            });
        return (
          <Fragment key={column[0]?.id ?? ci}>
            {editing?.gap(ci)}
            <div className={cn("flex min-w-0 flex-col", !flex && "flex-1")} style={flex ? { flex } : undefined}>
              {editing ? (spacer ? editing.spacer(column, ci) : editing.column(column, ci, cards)) : cards}
            </div>
          </Fragment>
        );
      })}
      {editing?.gap(columns.length)}
    </div>
  );
}
