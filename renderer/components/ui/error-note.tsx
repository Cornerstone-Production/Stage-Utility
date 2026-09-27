import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Something failed, said in one line where the operator is already looking.
 *
 * Above all for a read that did not come back. A failed fetch is not an empty
 * result, and drawing it as the empty state says something false about a
 * system that is fine — "no saved groups", "connect Planning Center" — so this
 * goes where that empty state would have been, never beside it. Say what could
 * not be loaded ("Couldn't load the saved groups."), and what the screen is
 * showing instead if it carries on without it.
 *
 * Danger-toned, because red is error (STYLE_GUIDE 2.3), and `role="alert"` so
 * it is announced the moment it appears, unlike EmptyState's neutral note.
 */
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11",
        className,
      )}
    >
      {children}
    </p>
  );
}
