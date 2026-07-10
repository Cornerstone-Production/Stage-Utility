import * as React from "react";
import { cn } from "../../lib/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "flex h-7 w-full rounded-md border border-line-strong bg-field",
          "px-2.5 py-1 text-[13px] text-fg placeholder:text-gray-a8",
          "transition-colors focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
