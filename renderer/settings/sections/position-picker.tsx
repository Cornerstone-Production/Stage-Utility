import { useState, type ChangeEvent } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import { cn } from "../../lib/cn";

interface PositionRangeEditorProps {
  /** The positions this slot accepts, each with its own optional note. */
  positions: SlotPositionMatch[];
  teamPositions: TeamPositionDTO[];
  onChange: (next: SlotPositionMatch[]) => void;
}

/** Sentinel for the "Any position" row — a nameless entry, where the note is the
 *  only constraint. Kept out of the position namespace so it can't collide with a
 *  real PCO position called "Any". */
const ANY = Symbol("any-position");
type Key = string | typeof ANY;

const keyOf = (p: SlotPositionMatch): Key => p.name ?? ANY;

/**
 * Tick every position a slot may accept; each ticked one gets its own optional
 * note. One control replaces the old single-position dropdown plus a slot-level
 * note field — the note has to be per-position for "Vocals note 4, or Acoustic
 * with any note" to be expressible at all.
 *
 * Built on Popover (not Select) so the search input can live inside the dropdown
 * without the Select's typeahead fighting the text field, and so ticking a
 * position doesn't close the list mid-selection.
 */
export function PositionRangeEditor({ positions, teamPositions, onChange }: PositionRangeEditorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q
    ? teamPositions.filter(
        (p) => p.positionName.toLowerCase().includes(q) || p.teamName.toLowerCase().includes(q),
      )
    : teamPositions;
  const teams = Array.from(new Set(filtered.map((p) => p.teamName)));

  const entryFor = (key: Key) => positions.find((p) => keyOf(p) === key);

  function toggle(key: Key) {
    const existing = entryFor(key);
    if (existing) onChange(positions.filter((p) => p !== existing));
    else onChange([...positions, key === ANY ? {} : { name: key }]);
  }

  function setNote(key: Key, note: string) {
    onChange(
      positions.map((p) =>
        keyOf(p) === key ? { ...p, notesStartsWith: note.trim() ? note : undefined } : p,
      ),
    );
  }

  const summary = positions.length
    ? positions.map((p) => p.name ?? "Any position").join(" · ")
    : "";

  const anyTicked = entryFor(ANY) !== undefined;

  return (
    <div className="flex flex-1 min-w-0 flex-col gap-1.5">
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
              "flex h-7 w-full min-w-0 items-center justify-between gap-1 rounded-md border border-gray-a6 bg-gray-a2",
              "px-2.5 py-1 text-footnote text-gray-12",
              "focus:outline-none focus:border-blue-8 focus:ring-1 focus:ring-blue-8",
            )}
          >
            <span className={cn("truncate", !summary && "text-gray-a8")}>
              {summary || "Select positions…"}
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
                  "h-7 w-full rounded border border-gray-a6 bg-gray-a2 px-2 text-footnote",
                  "text-gray-12 placeholder:text-gray-a8 focus:outline-none focus:border-blue-8",
                )}
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {/* Any position — matches on the note alone, across every position. */}
              {!q && (
                <button
                  type="button"
                  onClick={() => toggle(ANY)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-footnote text-gray-12",
                    "hover:bg-gray-a3",
                    anyTicked && "bg-gray-a3",
                  )}
                >
                  <CheckIcon className={cn("size-3.5 shrink-0", anyTicked ? "opacity-100 text-blue-10" : "opacity-0")} />
                  <span className="truncate">Any position</span>
                </button>
              )}
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
                        const selected = entryFor(p.positionName) !== undefined;
                        return (
                          <button
                            key={`${p.teamId}:${p.positionName}`}
                            type="button"
                            onClick={() => toggle(p.positionName)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-footnote text-gray-12",
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

      {/* One note box per ticked position. Kept outside the popover so the list
          stays a list and the notes stay visible while configuring the slot. */}
      {positions.length > 0 && (
        <div className="flex flex-col gap-1">
          {positions.map((p) => {
            const key = keyOf(p);
            return (
              <div key={key === ANY ? "__any__" : key} className="flex items-center gap-2">
                {/* With one position ticked the trigger above already names it, so
                    repeating it here is just noise — the row only needs to say what
                    the field is. Name each row once there is more than one, since
                    then the note has to be attributable to a position. */}
                <span className="flex-1 min-w-0 truncate text-caption1 text-gray-11">
                  {positions.length === 1 ? "Note starts with" : (p.name ?? "Any position")}
                </span>
                <input
                  value={p.notesStartsWith ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setNote(key, e.target.value)}
                  placeholder="note"
                  aria-label={`Note filter for ${p.name ?? "any position"}`}
                  className={cn(
                    "h-7 w-24 shrink-0 rounded-md border border-gray-a6 bg-gray-a2 px-2 text-footnote",
                    "text-gray-12 placeholder:text-gray-a8 focus:outline-none focus:border-blue-8",
                  )}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
