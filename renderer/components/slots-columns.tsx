import { cn } from "../lib/cn";
import { SlotPanel } from "./slot-panel";

/**
 * The kiosk's fill-height mic-slot columns. Stacked slots share a column. With a
 * `slotsLayout`, columns are sized in inches against the monitor's active width
 * and centered so they line up with the physical chargers; otherwise they share
 * width equally. Shared by the standalone slots view (stage-view.tsx) and the
 * embedded "Mic slots" object in custom layouts (layout-renderer.tsx) so both
 * render identically.
 */
export function SlotsColumns({
  slots,
  slotsLayout,
  emptySlotLogo,
  defaultAvatar,
  className,
}: {
  slots: Slot[];
  slotsLayout: SlotsLayout | null;
  emptySlotLogo: string | null;
  defaultAvatar?: string | null;
  className?: string;
}) {
  const sorted = [...slots].sort((a, b) => a.order - b.order);

  const columns: Slot[][] = [];
  for (const slot of sorted) {
    if (slot.stackWithPrevious && columns.length > 0) columns[columns.length - 1].push(slot);
    else columns.push([slot]);
  }

  const columnFlex = (col: Slot[]): string | undefined => {
    if (!slotsLayout || slotsLayout.displayWidthIn <= 0) return undefined;
    const inches = col[0]?.widthIn ?? slotsLayout.columnWidthIn;
    return `0 0 ${(inches / slotsLayout.displayWidthIn) * 100}%`;
  };
  const isSpacerColumn = (col: Slot[]) => col.every((s) => s.link.kind === "spacer");

  return (
    <div className={cn("flex min-h-0", slotsLayout && "justify-center", className)}>
      {columns.map((column, ci) => {
        const flex = columnFlex(column);
        return (
          <div
            key={column[0]?.id ?? ci}
            className={cn("flex min-w-0 flex-col", !flex && "flex-1")}
            style={flex ? { flex } : undefined}
          >
            {/* A spacer is a gap for charger alignment and nothing else — it used to
                be able to hold the empty-slot logo, which was never used. */}
            {isSpacerColumn(column)
              ? null
              : column.map((slot) => (
                  <SlotPanel key={slot.id} slot={slot} emptySlotLogo={emptySlotLogo} defaultAvatar={defaultAvatar} />
                ))}
          </div>
        );
      })}
    </div>
  );
}
