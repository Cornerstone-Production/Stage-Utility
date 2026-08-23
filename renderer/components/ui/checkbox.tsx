import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/cn";

/**
 * A themed checkbox, for choosing several things from a list.
 *
 * The app had none, so the two places that needed one used a bare
 * `<input type="checkbox">` tinted with `accent-color`. That still draws the
 * operating system's own control — chunky, its own blue, square corners — which
 * read as a stray next to everything around it.
 *
 * Use this when the choices are independent and take effect together, on some
 * later action. For a setting that applies the moment it is flipped, use
 * `Switch` — the difference is what a person expects to happen next.
 *
 * THE CHECKED STYLE KEYS OFF `aria-checked`, NOT `data-state`.
 *
 * Radix sets both, and `data-state` is the idiomatic one — but `Tooltip` wraps
 * its child in a `Trigger asChild`, which merges the TOOLTIP's own
 * `data-state` (open / closed) onto the very same element. Every checkbox in
 * the service-history rundown is inside a tooltip, so each one rendered
 * `data-state="closed"`, `data-[state=checked]` never matched, and a checked
 * box kept the unchecked background — a white tick on a near-white field. It
 * was invisible in light mode and merely low-contrast in dark, which is why it
 * was reported as a light-mode problem.
 *
 * `aria-checked` is the accessibility contract, so it is not something a
 * wrapper is free to overwrite. Radio and Switch key off it for the same
 * reason. See state-attribute-styling.test.tsx.
 */
export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer size-4 shrink-0 rounded-[5px] border border-line-strong bg-field",
      "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
      "disabled:cursor-not-allowed disabled:opacity-40",
      "aria-checked:border-accent aria-checked:bg-accent",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-white">
      <CheckIcon className="size-3" strokeWidth={3.5} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";
