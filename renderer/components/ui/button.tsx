import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "accent" | "filled" | "transparent";
  size?: "small" | "medium";
  iconOnly?: boolean;
  /**
   * Hover tooltip text. Icon-only buttons fall back to their `aria-label`
   * automatically, so every labelled icon button gets a tooltip for free. Pass
   * an explicit string to override, or `""` to suppress.
   */
  tooltip?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "transparent", size = "medium", iconOnly, tooltip, children, ...props }, ref) => {
    const btn = (
      <button
        ref={ref}
        className={cn(
          // Base
          "inline-flex items-center justify-center gap-1.5 rounded-md font-medium",
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          "disabled:pointer-events-none disabled:opacity-40 select-none",
          // Size
          size === "small" && !iconOnly && "h-6 px-2 text-[12px]",
          size === "small" && iconOnly && "h-6 w-6 p-0 text-[12px]",
          size === "medium" && !iconOnly && "h-8 px-3 text-[13px]",
          size === "medium" && iconOnly && "h-8 w-8 p-0 text-[13px]",
          // Variant
          variant === "accent" && [
            "bg-accent text-white",
            "hover:bg-accent-hover active:bg-accent-active",
          ],
          variant === "filled" && [
            "bg-fill text-fg",
            "hover:bg-fill-hover active:bg-fill-active",
          ],
          variant === "transparent" && [
            "bg-transparent text-fg-muted",
            "hover:bg-fill active:bg-fill-hover",
          ],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );

    // Tooltip text: explicit `tooltip`, else the icon button's aria-label. A
    // global Tooltip.Provider is mounted in both app entrypoints. No icon-only
    // Button is used as another Radix trigger, so wrapping here is safe.
    const tipText = tooltip !== undefined ? tooltip : iconOnly ? (props["aria-label"] as string | undefined) : undefined;
    if (!tipText || props.disabled) return btn;

    return (
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{btn}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            sideOffset={6}
            className={cn(
              "z-50 rounded-md bg-gray-12 px-2 py-1 text-[11px] font-medium text-gray-1 shadow-md",
              "select-none data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
            )}
          >
            {tipText}
            <TooltipPrimitive.Arrow className="fill-gray-12" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    );
  },
);
Button.displayName = "Button";
