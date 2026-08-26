import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
      "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // aria-checked, not data-state — a Tooltip wrapper overwrites data-state.
      // See the note in checkbox.tsx and state-attribute-styling.test.tsx.
      "aria-checked:bg-accent dark:aria-checked:bg-accent/85 aria-[checked=false]:bg-gray-a6",
      className,
    )}
    ref={ref}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block size-4 rounded-full bg-white shadow-sm",
        // The THUMB may keep data-state: it is a child, and `asChild` only
        // merges onto the root. Left alone deliberately — without the track fix
        // above, a tooltip-wrapped switch showed the knob thrown right over a
        // grey track, which is the half-broken state that makes this worth a
        // comment rather than a silent rewrite.
        "transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
