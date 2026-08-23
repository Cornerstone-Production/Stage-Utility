import { useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
// A popover rather than a native control, unlike Select. HTML has no native
// multi-select DROPDOWN: adding `multiple` to a <select> turns it into an inline
// scrolling list box, not an OS popup, so there is nothing native to opt into. The
// position picker is custom for the same reason (it also needs a search field).
// Styling therefore follows that picker — a bare tick, not a filled checkbox.
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "../../lib/cn";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/** A compact multi-select: a Select-styled trigger that summarizes the chosen
 *  items and opens a popover of checkable rows. Keeps the list hidden until wanted
 *  (unlike an always-expanded toggle grid) and stays open while you check items. */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Select…",
  summary,
  className,
  disabled,
  searchable,
  footer,
  onOptionContextMenu,
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Override the collapsed-trigger text (else "N selected" / a joined preview). */
  summary?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Show a search field above the list.
   *
   * Worth it past a dozen options and noise below that, so it is opt-in: a
   * screen picker in a building with twenty TVs needs it, a three-item filter
   * does not. All/None act on what the search has NARROWED to, which is what
   * makes the pair useful — "tick every foyer screen" is a search and one click.
   */
  searchable?: boolean;
  /** Trailing row, e.g. "New tag…", so a picker can also create. */
  footer?: React.ReactNode;
  /** Right-click on one option's row. For the things you do to an option itself
   *  — rename it, delete it — which have no other home once the list of options
   *  IS the list of the things. */
  onOptionContextMenu?: (value: string, e: React.MouseEvent) => void;
}) {
  const [search, setSearch] = useState("");
  const selectedSet = new Set(selected);
  const chosen = options.filter((o) => selectedSet.has(o.value));
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  }, [options, search]);
  const label =
    summary ??
    (chosen.length === 0
      ? placeholder
      : chosen.length === options.length
        ? `All (${chosen.length})`
        : chosen.length <= 2
          ? chosen.map((o) => o.label).join(", ")
          : `${chosen.length} selected`);

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        disabled={disabled}
        className={cn(
          "flex h-7 items-center justify-between gap-1 rounded-md border border-line-strong bg-field",
          "px-2.5 py-1 text-footnote text-fg whitespace-nowrap",
          "focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus",
          "disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-focus",
          className,
        )}
      >
        <span className={cn("truncate", chosen.length === 0 && "text-gray-a8")}>{label}</span>
        <ChevronDownIcon className="size-3.5 text-gray-9 shrink-0" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] min-w-52 overflow-hidden rounded-md border border-line-strong bg-popover backdrop-blur-xl shadow-md",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          {searchable && (
            <div className="relative border-b border-line">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-gray-9" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                aria-label="Search options"
                autoFocus
                className="w-full bg-transparent py-1.5 pl-8 pr-2.5 text-footnote text-fg outline-none placeholder:text-gray-a8"
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
            <span className="text-caption2 text-gray-9">{chosen.length} of {options.length}</span>
            <div className="flex items-center gap-3 text-caption2">
              {/* All and None act on what the SEARCH narrowed to. Acting on the
                  whole list from behind a filter is how "tick these four" ticks
                  twenty, and the operator does not find out until a wall
                  changes. Outside a search this is the whole list either way. */}
              <button
                className="text-accent hover:text-accent-hover"
                onClick={() => onChange([...new Set([...selected, ...shown.map((o) => o.value)])])}
              >
                All
              </button>
              <button
                className="text-gray-10 hover:text-gray-12"
                onClick={() => {
                  const drop = new Set(shown.map((o) => o.value));
                  onChange(selected.filter((v) => !drop.has(v)));
                }}
              >
                None
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-0.5 p-1 max-h-[min(20rem,var(--radix-popover-content-available-height))] overflow-y-auto">
            {shown.length === 0 && (
              <p className="px-2 py-3 text-center text-caption2 text-gray-9">Nothing matches that.</p>
            )}
            {shown.map((o) => {
              const on = selectedSet.has(o.value);
              return (
                <button
                  key={o.value}
                  onClick={() => toggle(o.value)}
                  onContextMenu={
                    onOptionContextMenu
                      ? (e) => {
                          e.preventDefault();
                          onOptionContextMenu(o.value, e);
                        }
                      : undefined
                  }
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-footnote text-fg outline-none",
                    // focus-VISIBLE, not focus: a clicked button keeps focus, so
                    // `focus:` left the row lit after it had been unticked — the
                    // highlight said "selected" about something that no longer was.
                    "hover:bg-fill focus-visible:bg-fill",
                    on && "bg-fill",
                  )}
                >
                  {/* A bare tick, not a filled checkbox — matching the position picker,
                      which is the app's other multi-select. A column of solid blue
                      squares reads much heavier than the list it is describing. The icon
                      always occupies its space so labels stay aligned. */}
                  <CheckIcon
                    className={cn("size-3.5 shrink-0", on ? "opacity-100 text-accent" : "opacity-0")}
                    strokeWidth={3}
                  />
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })}
          </div>
          {footer && <div className="border-t border-line p-1">{footer}</div>}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
