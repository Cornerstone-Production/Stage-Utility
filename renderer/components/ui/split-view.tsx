import * as React from "react";
import { cn } from "../../lib/cn";

interface SplitViewProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  sidebarWidth?: number;
  className?: string;
  /** Persisted resize key — accepted but ignored (stateless layout). */
  storageKey?: string;
  /** Min/max/default sidebar size constraints — accepted but ignored. */
  sidebarSize?: { default: number; min: number; max: number };
}

/**
 * Two-panel layout: fixed-width sidebar on the left, flex-fill main area on the right.
 * sidebarWidth defaults to 200px.
 */
export function SplitView({ sidebar, children, sidebarWidth = 200, className }: SplitViewProps) {
  return (
    <div className={cn("flex h-full w-full overflow-hidden", className)}>
      {/* Sidebar */}
      <div
        className="shrink-0 h-full overflow-hidden"
        style={{ width: `${sidebarWidth}px` }}
      >
        {sidebar}
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        {children}
      </div>
    </div>
  );
}
