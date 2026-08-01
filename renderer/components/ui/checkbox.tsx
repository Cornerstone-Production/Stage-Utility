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
      "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
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
