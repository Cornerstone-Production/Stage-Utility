import * as React from "react";
import { cn } from "../../lib/cn";

interface StatusProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "success" | "warning" | "error" | "info" | "neutral";
}

const variantColors: Record<NonNullable<StatusProps["variant"]>, string> = {
  success: "bg-green-9",
  warning: "bg-yellow-9",
  error: "bg-red-9",
  info: "bg-accent",
  neutral: "bg-gray-9",
};

export function Status({ variant = "neutral", className, children, ...props }: StatusProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} {...props}>
      <span
        className={cn(
          "inline-block size-2 rounded-full shrink-0",
          variantColors[variant],
        )}
      />
      {children && (
        <span className="text-caption1 text-fg-muted">{children}</span>
      )}
    </span>
  );
}
