import { useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/cn";

/**
 * A lightweight disclosure: a chevron + label header that toggles a collapsible
 * region. Standardizes the manual chevron pattern used across the app (slot
 * "Options", integration cards, caption colors). The toggle lives on the
 * label button only, so interactive controls passed via `right` (e.g. an enable
 * switch) don't collapse the section.
 */
export function Collapsible({
  label,
  summary,
  defaultOpen = false,
  right,
  children,
  className,
  headerClassName,
}: {
  /** Header text/content next to the chevron. */
  label: ReactNode;
  /** Muted hint shown after the label only while collapsed (e.g. "mic · IEM"). */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Non-toggling trailing header content (e.g. a status badge + enable switch). */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("flex flex-col", className)}>
      <div className={cn("flex items-center gap-2", headerClassName)}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 min-w-0 items-center gap-1.5 py-1 text-caption1 font-medium text-gray-10 hover:text-gray-12 transition-colors text-left"
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <span className="min-w-0">{label}</span>
          {!open && summary != null && (
            <span className="truncate text-caption2 font-normal text-gray-8">{summary}</span>
          )}
        </button>
        {right}
      </div>
      {open && <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}
