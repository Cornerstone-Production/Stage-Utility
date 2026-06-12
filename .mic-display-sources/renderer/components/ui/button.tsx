import * as React from "react";
import { cn } from "../../lib/cn";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "accent" | "filled" | "transparent";
  size?: "small" | "medium";
  iconOnly?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "transparent", size = "medium", iconOnly, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          // Base
          "inline-flex items-center justify-center gap-1.5 rounded-md font-medium",
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8",
          "disabled:pointer-events-none disabled:opacity-40 select-none",
          // Size
          size === "small" && !iconOnly && "h-6 px-2 text-[12px]",
          size === "small" && iconOnly && "h-6 w-6 p-0 text-[12px]",
          size === "medium" && !iconOnly && "h-8 px-3 text-[13px]",
          size === "medium" && iconOnly && "h-8 w-8 p-0 text-[13px]",
          // Variant
          variant === "accent" && [
            "bg-blue-9 text-white",
            "hover:bg-blue-10 active:bg-blue-11",
          ],
          variant === "filled" && [
            "bg-gray-a3 text-gray-12",
            "hover:bg-gray-a4 active:bg-gray-a5",
          ],
          variant === "transparent" && [
            "bg-transparent text-gray-11",
            "hover:bg-gray-a3 active:bg-gray-a4",
          ],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
