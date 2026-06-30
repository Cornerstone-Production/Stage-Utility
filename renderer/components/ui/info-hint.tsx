import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { InfoIcon } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * A small "i" button that opens a short help blurb on click. Click-to-open
 * (rather than hover) so the text is readable on touch and stays up while read.
 * Opt-in contextual help — adds no visible clutter until clicked.
 */
export function InfoHint({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label="More info"
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-full text-gray-9",
            "hover:text-gray-11 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8",
            className,
          )}
        >
          <InfoIcon className="size-3.5" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "z-50 max-w-[16rem] rounded-lg border border-gray-a6 bg-gray-2 px-3 py-2 text-[12px] leading-snug text-gray-11 shadow-md",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          {children}
          <PopoverPrimitive.Arrow className="fill-gray-a6" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
