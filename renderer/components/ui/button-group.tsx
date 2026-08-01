import * as React from "react";
import { cn } from "../../lib/cn";

interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {}

// A small gap, because every Button carries its own rounded corners. Flush against
// each other two of them read as one control that has been cut in half, rather than
// as a pair — the corners meet and leave a pinched notch. A true segmented control
// would square the inner corners instead; separating them is the honest version of
// what these already are.

export function ButtonGroup({ className, children, ...props }: ButtonGroupProps) {
  return (
    <div
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    >
      {children}
    </div>
  );
}
