import * as React from "react";
import { cn } from "../../lib/cn";

/**
 * A consistent empty-state block: icon + title + optional hint + optional CTA.
 * Replaces bare plaintext "nothing here yet" messages so dead-ends point at a
 * next action.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-a5 px-4 py-8 text-center",
        className,
      )}
    >
      {icon && <div className="text-gray-8 [&_svg]:size-6">{icon}</div>}
      <div className="text-callout font-medium text-gray-11">{title}</div>
      {hint && <div className="text-caption2 text-gray-9 max-w-xs leading-snug">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
