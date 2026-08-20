import * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "../../lib/cn";
import { Tooltip } from "./tooltip";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "accent" | "filled" | "transparent";
  size?: "small" | "medium";
  iconOnly?: boolean;
  /**
   * Hover tooltip text. Icon-only buttons fall back to their `aria-label`
   * automatically, so every labeled icon button gets a tooltip for free. Pass
   * an explicit string to override, or `""` to suppress.
   */
  tooltip?: string;
  /**
   * Render the child element instead of a <button>, keeping every style.
   *
   * For the cases where the thing must genuinely be something else — a download
   * is an <a href download> so the browser takes the filename from
   * Content-Disposition and middle-click works. The alternative was copying the
   * class list onto an anchor, which is how two controls that should look
   * identical stop being identical.
   */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "transparent", size = "medium", iconOnly, tooltip, asChild, children, ...props }, ref) => {
    const Comp = asChild ? Slot.Root : "button";
    const btn = (
      <Comp
        ref={ref}
        className={cn(
          // Base
          "inline-flex items-center justify-center gap-1.5 rounded-md font-medium",
          "transition-colors duration-(--motion-instant) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          "disabled:pointer-events-none disabled:opacity-40 select-none",
          // Size
          size === "small" && !iconOnly && "h-6 px-2 text-caption1",
          size === "small" && iconOnly && "h-6 w-6 p-0 text-caption1",
          size === "medium" && !iconOnly && "h-8 px-3 text-footnote",
          size === "medium" && iconOnly && "h-8 w-8 p-0 text-footnote",
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
      </Comp>
    );

    // Tooltip text: explicit `tooltip`, else the icon button's aria-label, so a
    // labeled icon button is described without repeating itself at the call site.
    const tipText = tooltip !== undefined ? tooltip : iconOnly ? (props["aria-label"] as string | undefined) : undefined;
    if (!tipText) return btn;

    // A disabled button takes `pointer-events: none`, so it never sees the hover
    // that would open its own tooltip — and "why is this grayed out" is exactly
    // when the label is wanted. Hang the trigger on a wrapper that still receives
    // events. `inline-flex` so the wrapper measures the same as the button did.
    if (props.disabled) {
      return (
        <Tooltip label={tipText}>
          <span className="inline-flex">{btn}</span>
        </Tooltip>
      );
    }
    return <Tooltip label={tipText}>{btn}</Tooltip>;
  },
);
Button.displayName = "Button";
