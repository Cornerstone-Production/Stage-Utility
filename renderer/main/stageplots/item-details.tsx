// item-details.tsx — what a tap on an item shows on /stageplots and the public
// page: its label and kind, its notes, and its inputs, numbered; or, for a
// connection point linked to the patch, the patch channels through its device
// ("Patch channels · Main patch") in place of its inputs. Beside the item on a desk; on a
// phone (under 640 px) a bottom sheet instead, so a long input list does not
// cover the item. The switch is CSS (the sm: breakpoint), so it is checked in a
// browser, not in jsdom, which loads no stylesheet.

import type { PatchChannels, PlotItem } from "@main/types/stageplots";

import { cn } from "../../lib/cn";
import { eyebrow } from "./doc-helpers";
import { Mono } from "./mono";
import { itemKindName } from "./symbols";

/** The popover's width on a desk, in CSS pixels. */
export const DETAILS_WIDTH = 250;

/** Where the popover goes beside an item's box, both relative to the plot's frame:
 *  right of it, or left when there is no room, kept inside the frame. */
export function detailsPosition(item: DOMRect | { left: number; right: number; top: number }, frame: { left: number; top: number; width: number }) {
  let left = item.right - frame.left + 10;
  if (left + DETAILS_WIDTH > frame.width - 8) left = item.left - frame.left - DETAILS_WIDTH - 10;
  return { left: Math.max(8, left), top: Math.max(8, item.top - frame.top - 6) };
}

const row = "grid items-baseline gap-2 border-t border-line py-1 first:border-t-0 max-sm:py-1.5";

export function ItemDetails({
  item,
  at,
  onClose,
  channels = null,
}: {
  item: PlotItem;
  at: { left: number; top: number } | null;
  onClose: () => void;
  /** A linked point's patch channels, listed instead of its inputs; null for anything else. */
  channels?: PatchChannels | null;
}) {
  return (
    <div
      data-item-details=""
      role="dialog"
      aria-label={item.label || itemKindName(item)}
      data-testid="item-details"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      style={at ? ({ "--details-left": `${at.left}px`, "--details-top": `${at.top}px` } as React.CSSProperties) : undefined}
      className={cn(
        // Frosted like the app's other popovers, so the plot under it does not read through.
        "z-30 border-line-strong bg-popover text-caption1 shadow-[var(--su-shadow-2)] backdrop-blur-xl",
        // Phone: a sheet along the bottom of the screen.
        "fixed inset-x-0 bottom-0 rounded-t-[18px] border-t px-[18px] pt-2 pb-[max(30px,env(safe-area-inset-bottom))] text-footnote",
        // Desk: a popover beside the item.
        "sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-[var(--details-top,8px)] sm:left-[var(--details-left,8px)] sm:w-[250px] sm:rounded-[10px] sm:border sm:px-3 sm:py-2.5 sm:text-caption1",
      )}
    >
      <div className="mx-auto mb-2.5 h-1 w-9 rounded-sm bg-line-strong sm:hidden" aria-hidden />
      <div className="flex items-center gap-2">
        {item.color ? (
          <span className="size-2.5 flex-none rounded-full" style={{ background: item.color }} />
        ) : (
          <span className="size-2.5 flex-none rounded-full border border-dashed border-fg-subtle" />
        )}
        <b className="min-w-0 truncate text-footnote font-semibold text-fg">
          <Mono text={item.label || "Unlabelled"} />
        </b>
        <small className="ml-auto text-[11px] whitespace-nowrap text-fg-subtle">{itemKindName(item)}</small>
      </div>
      {item.notes && (
        <p className="mt-1.5 whitespace-pre-line text-fg-muted">
          <Mono text={item.notes} />
        </p>
      )}
      {channels ? (
        <>
          <span className={cn(eyebrow, "mt-2.5")}>
            <Mono text={`Patch channels · ${channels.sheet}`} />
          </span>
          <ul className="mt-1" data-testid="patch-channels">
            {channels.channels.map((c, i) => (
              <li key={i} className={cn(row, "grid-cols-[auto_minmax(0,1fr)_auto]")}>
                <span className="text-[11px] text-fg-subtle">
                  <Mono text={c.channel} />
                </span>
                <span className="min-w-0 text-fg">
                  <Mono text={c.label} />
                </span>
                <span className="text-[11px] text-fg-muted">
                  <Mono text={c.path} />
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : item.inputs.length > 0 && (
        <>
          <span className={cn(eyebrow, "mt-2.5")}>Inputs</span>
          <ul className="mt-1" data-testid="item-inputs">
            {item.inputs.map((name, i) => (
              <li key={i} className={cn(row, "grid-cols-[auto_minmax(0,1fr)]")}>
                <span className="font-mono text-[11px] text-fg-subtle tabular-nums">{i + 1}</span>
                <span className="text-fg">
                  <Mono text={name} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
