import { useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import { cn } from "../../lib/cn";

interface PositionPickerProps {
  /** Currently selected position name (empty when none). */
  value: string;
  teamPositions: TeamPositionDTO[];
  onChange: (positionName: string) => void;
}

/**
 * Searchable, team-grouped position picker. Built on Popover (not Select) so a
 * search input can live inside the dropdown without the Select's typeahead/focus
 * fighting the text field.
 */
export function PositionPicker({ value, teamPositions, onChange }: PositionPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q
    ? teamPositions.filter(
        (p) => p.positionName.toLowerCase().includes(q) || p.teamName.toLowerCase().includes(q),
      )
    : teamPositions;
  const teams = Array.from(new Set(filtered.map((p) => p.teamName)));

  function select(positionName: string) {
    onChange(positionName);
    setOpen(false);
    setQuery("");
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 flex-1 min-w-0 items-center justify-between gap-1 rounded-md border border-gray-a6 bg-gray-a2",
            "px-2.5 py-1 text-[13px] text-gray-12",
            "focus:outline-none focus:border-blue-8 focus:ring-1 focus:ring-blue-8",
          )}
        >
          <span className={cn("truncate", !value && "text-gray-a8")}>
            {value || "Select position…"}
          </span>
          <ChevronDownIcon className="size-3.5 text-gray-9 shrink-0" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-hidden rounded-md",
            "border border-gray-a6 bg-gray-2 shadow-md",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="border-b border-gray-a4 p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search positions…"
              className={cn(
                "h-7 w-full rounded border border-gray-a6 bg-gray-a2 px-2 text-[13px]",
                "text-gray-12 placeholder:text-gray-a8 focus:outline-none focus:border-blue-8",
              )}
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-4 text-center text-caption1 text-gray-9">
                No positions found
              </div>
            ) : (
              teams.map((team) => (
                <div key={team}>
                  <div className="px-2 pt-2 pb-1 text-caption2 font-medium uppercase tracking-wide text-gray-9">
                    {team}
                  </div>
                  {filtered
                    .filter((p) => p.teamName === team)
                    .map((p) => {
                      const selected = value === p.positionName;
                      return (
                        <button
                          key={`${p.teamId}:${p.positionName}`}
                          type="button"
                          onClick={() => select(p.positionName)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] text-gray-12",
                            "hover:bg-gray-a3",
                            selected && "bg-gray-a3",
                          )}
                        >
                          <CheckIcon
                            className={cn(
                              "size-3.5 shrink-0",
                              selected ? "opacity-100 text-blue-10" : "opacity-0",
                            )}
                          />
                          <span className="truncate">{p.positionName}</span>
                        </button>
                      );
                    })}
                </div>
              ))
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
