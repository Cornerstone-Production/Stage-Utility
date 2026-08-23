import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { cn } from "../../lib/cn";

/**
 * A themed radio, for choosing ONE thing from a short list.
 *
 * The same story as Checkbox before it: the only place in the app that needed
 * one used a bare `<input type="radio">`, which draws the operating system's
 * own control — its own blue, its own size, ignoring the theme entirely — and
 * read as a stray beside everything around it. In dark mode it did not even
 * look enabled.
 *
 * Use this when the choices are mutually exclusive and take effect on some
 * later action. For an either/or that applies the moment it is flipped, use
 * `Switch`; for several independent choices, `Checkbox`. The difference is what
 * a person expects to happen next.
 */
export const RadioGroup = RadioGroupPrimitive.Root;

export const Radio = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "peer size-4 shrink-0 rounded-full border border-line-strong bg-field",
      "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
      "disabled:cursor-not-allowed disabled:opacity-40",
      // aria-checked, not data-state — a Tooltip wrapper overwrites data-state.
      // See the note in checkbox.tsx and state-attribute-styling.test.tsx.
      "aria-checked:border-accent aria-checked:bg-accent",
      className,
    )}
    {...props}
  >
    {/* A dot, not a tick — the shape is what says "one of these", and it is
        drawn in the same white the checkbox's tick uses so a form carrying both
        reads as one set of controls. */}
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <span className="block size-1.5 rounded-full bg-white" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
Radio.displayName = "Radio";
