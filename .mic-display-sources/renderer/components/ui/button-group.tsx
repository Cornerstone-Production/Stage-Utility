import * as React from "react";
import { cn } from "../../lib/cn";

interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {}

export function ButtonGroup({ className, children, ...props }: ButtonGroupProps) {
  return (
    <div
      className={cn("inline-flex items-center", className)}
      {...props}
    >
      {children}
    </div>
  );
}
