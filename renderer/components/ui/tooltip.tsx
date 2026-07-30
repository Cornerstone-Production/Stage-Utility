import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "../../lib/cn";

/**
 * A short label for a control that shows no text of its own — an icon button, a
 * truncated name, a disabled action that needs a reason.
 *
 * This replaces the native `title` attribute, which the browser draws itself and
 * which cannot be styled to match anything around it.
 *
 * It opens on hover and on keyboard focus, and — like every tooltip — deliberately
 * NOT on tap, since a tap on a touch screen is a click on the control underneath.
 * Much of this app runs on tablets propped next to a console, so treat a tooltip
 * as an extra for pointer users and never as the only place something is said.
 * Anything an operator must know needs to be visible, or in an `InfoHint`, whose
 * blurb opens on click and so works on touch.
 *
 * Use this for a LABEL. For a sentence or two of explanation, use `InfoHint`.
 *
 * ```tsx
 * <Tooltip label="Send to back">
 *   <IconButton icon={SendToBackIcon} />
 * </Tooltip>
 * ```
 */
export function Tooltip({
  label,
  children,
  side = "top",
  className,
}: {
  /** The text to show. Nothing renders when this is empty. */
  label: React.ReactNode;
  /** The control being labelled. Must forward a ref and its props. */
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  // An empty label would otherwise open a bare floating box on hover.
  if (label == null || label === "" || label === false) return children;

  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            // Matches InfoHint's surface, so the two read as one system.
            "z-50 max-w-[18rem] rounded-lg border border-line-strong bg-popover px-2.5 py-1.5",
            "text-caption1 leading-snug text-fg-muted shadow-md backdrop-blur-xl",
            "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
            "data-[state=delayed-open]:zoom-in-95",
            className,
          )}
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-gray-a6" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
