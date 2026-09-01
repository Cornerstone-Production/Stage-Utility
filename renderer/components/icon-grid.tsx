// icon-grid.tsx — the searchable set, with no opinion about where it sits.
//
// It cannot own its placement or dismissal: it is hosted twice, inline in the
// colour panel on a Screens card and in a small menu of its own on the console
// rail. Both of those belong to the host.
//
// Cells are drawn in the theme ACCENT rather than in the colour being edited.
// Tinting them to the draft made the grid a different colour on every card and
// matched nothing else in the app's chrome.

import { useEffect, useMemo, useRef, useState } from "react";
import { ICON_SET, searchIcons } from "./icon-set";
import { cn } from "../lib/cn";

export function IconGrid({
  current,
  onPick,
  onClear,
}: {
  current?: string | null;
  onPick: (name: string) => void;
  /** Back to the item's built-in icon. */
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => searchIcons(query), [query]);

  // Typing is how a set this size is used, so the field takes focus.
  useEffect(() => {
    search.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={search}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search icons…"
        aria-label="Search icons"
        className="h-7 w-full rounded-md border border-line bg-surface px-2 text-caption1 text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />

      <div className="max-h-[184px] overflow-y-auto">
        {matches.length === 0 ? (
          <p className="px-1 py-3 text-caption1 text-fg-muted">Nothing matches “{query}”.</p>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {matches.map(({ name, icon: Icon }) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={name}
                aria-pressed={current === name}
                onClick={() => onPick(name)}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-md transition-colors",
                  "hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  current === name && "bg-fill ring-1 ring-accent",
                )}
              >
                {/* The theme accent, like every other icon in the app's chrome.
                    Drawing each cell in the colour being edited made the grid a
                    different colour on every card and matched nothing around it. */}
                <Icon className="size-4 text-accent" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line pt-2">
        <span className="text-caption2 text-fg-muted">
          {matches.length} of {ICON_SET.length}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="rounded-md px-2 py-1 text-caption1 text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Use the default
        </button>
      </div>
    </div>
  );
}
