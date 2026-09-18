// customize.tsx — one control per section, replacing the chip rows.
//
// The chips were three rows of toggles (Chart, Summary, and SPL's "Show
// metrics") sitting above the thing they configured, so the first ~90px of
// every section was configuration rather than the service. This is the same
// choices behind a sliders button at the section's right.

import { Popover as PopoverPrimitive } from "radix-ui";
import { SlidersHorizontalIcon } from "lucide-react";

import { Checkbox } from "../../../components/ui/checkbox";
import { cn } from "../../../lib/cn";

export interface CustomizeOption {
  key: string;
  label: string;
}

export interface CustomizeGroup {
  id: string;
  label: string;
  options: CustomizeOption[];
}

export interface CustomizeProps {
  /** Names the popover — two of these sit on one page (Attendance and Sound). */
  label: string;
  groups: CustomizeGroup[];
  /** Every ticked key across every group. */
  selected: string[];
  /** Called with the toggled key; the caller owns persistence. */
  onToggle: (key: string) => void;
}

/** The sliders button and its popover. Groups with no options are dropped —
 *  a record with no Smaart metrics should not show an empty "Metrics" heading. */
export function CustomizePopover({ label, groups, selected, onToggle }: CustomizeProps) {
  const on = new Set(selected);
  const shown = groups.filter((g) => g.options.length > 0);
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label={label}
        className={cn(
          "touch-target flex size-7 items-center justify-center rounded-md border border-line-strong bg-field text-fg-muted",
          "hover:bg-fill hover:text-fg focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus",
          "data-[state=open]:border-focus data-[state=open]:text-fg",
        )}
      >
        <SlidersHorizontalIcon className="size-3.5" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label={label}
          className={cn(
            "z-50 min-w-56 overflow-hidden rounded-md border border-line-strong bg-popover shadow-md backdrop-blur-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="max-h-[min(24rem,var(--radix-popover-content-available-height))] overflow-y-auto p-1">
            {shown.map((group, gi) => (
              <div key={group.id} className={cn("flex flex-col gap-0.5 py-1", gi > 0 && "border-t border-line pt-2")}>
                <span className="px-2 pb-1 text-caption2 uppercase tracking-wider text-fg-subtle">{group.label}</span>
                {group.options.map((opt) => (
                  <label
                    key={opt.key}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-footnote text-fg hover:bg-fill"
                  >
                    <Checkbox
                      checked={on.has(opt.key)}
                      onCheckedChange={() => onToggle(opt.key)}
                    />
                    <span className="truncate">{opt.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
