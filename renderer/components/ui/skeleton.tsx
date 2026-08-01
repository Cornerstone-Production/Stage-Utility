import * as React from "react";
import { cn } from "../../lib/cn";

/**
 * A pulsing placeholder block for loading states — calmer than a bare spinner
 * because it hints at the shape of the content that's arriving. Respects
 * prefers-reduced-motion (Tailwind's animate-pulse is disabled there).
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-fill motion-reduce:animate-none", className)} {...props} />;
}

/** A few stacked skeleton lines — a common "list/section is loading" placeholder. */
export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
