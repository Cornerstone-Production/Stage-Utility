import { useState, type ChangeEvent } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Switch } from "../../components/ui";
import { useAllTeamPositions, useTeamPositions } from "../../app/queries";
import { useStageState } from "../../main/use-stage-state";
import { useEditingTarget } from "./editing-target";

interface PositionRangeEditorProps {
  /** The positions this slot accepts, each with its own optional note. */
  positions: SlotPositionMatch[];
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
 * The list is the positions of the service type being EDITED (the plan
 * switcher's target), not the live one: a board for another type is built from
 * that type's positions. Ticked positions are pinned in a Selected group at the
 * top, so one the edited type does not have is still there to be unticked. A
 * position matches by NAME on any type that has it, so ticking another type's
 * position (the header switch lists them) works wherever that name exists.
 *
 * Built on Popover (not Select) so the search input can live inside the dropdown
 * without the Select's typeahead fighting the text field, and so ticking a
 * position doesn't close the list mid-selection.
 */
export function PositionRangeEditor({ positions, onChange }: PositionRangeEditorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showOthers, setShowOthers] = useState(false);

  const { state } = useStageState();
  const editing = useEditingTarget();
  const editedTypeId = editing.target.serviceTypeId;
  const pcoConfigured = !!state?.pcoConfigured;

  const here = useTeamPositions(editedTypeId, pcoConfigured);
  // Runs only while the switch is on; once read, the cache keeps answering, which
  // is what lets a Selected row name its type with the switch back off.
  const all = useAllTeamPositions(showOthers && open && pcoConfigured);
  const hereList = here.data ?? [];
  const otherRows = (all.data?.positions ?? []).filter((p) => p.serviceTypeId !== editedTypeId);
  const failedTypes = all.data?.failed ?? [];

  const q = query.trim().toLowerCase();
  const hit = (...parts: string[]) => !q || parts.some((t) => t.toLowerCase().includes(q));

  const entryFor = (key: Key) => positions.find((p) => keyOf(p) === key);
  const hereNames = new Set(hereList.map((p) => p.positionName));
  const selectedNames = new Set(positions.flatMap((p) => (p.name === undefined ? [] : [p.name])));

  // Selected, in tick order. The note rides on the entry, so moving between
  // groups never touches it.
  const selected = positions.filter(
    (p): p is SlotPositionMatch & { name: string } => p.name !== undefined && hit(p.name),
  );
  // Which types, other than this one, carry a position of that name — known only
  // once the other types have been read.
  const typesFor = (name: string) => [
    ...new Set(otherRows.filter((p) => p.positionName === name).map((p) => p.serviceTypeName)),
  ];
  const teamOf = (name: string) => hereList.find((p) => p.positionName === name)?.teamName;
  function selectedTag(name: string): string | null {
    // Only judge once this type's list has actually arrived: before that, every
    // position looks "not in this service type".
    if (!here.isSuccess || hereNames.has(name)) return null;
    const types = typesFor(name);
    return types.length > 0 ? `${types.join(", ")} only` : "not in this service type";
  }

  const teamRows = hereList.filter(
    (p) => !selectedNames.has(p.positionName) && hit(p.positionName, p.teamName),
  );
  const teams = Array.from(new Set(teamRows.map((p) => p.teamName)));

  const otherTypes = showOthers
    ? Array.from(new Set(otherRows.map((p) => p.serviceTypeName))).flatMap((typeName) => {
        const rows = otherRows.filter(
          (p) =>
            p.serviceTypeName === typeName &&
            !hereNames.has(p.positionName) &&
            !selectedNames.has(p.positionName) &&
            hit(p.positionName, p.teamName, typeName),
        );
        return rows.length > 0 ? [{ typeName, rows }] : [];
      })
    : [];

  const anyVisible = hit("Any position");
  const nothingToShow =
    selected.length === 0 && !anyVisible && teamRows.length === 0 && otherTypes.length === 0;

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

  return (
    <div className="flex flex-1 min-w-0 flex-col gap-1.5">
      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setQuery("");
            setShowOthers(false);
          }
        }}
      >
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className={cn(
              "flex h-7 w-full min-w-0 items-center justify-between gap-1 rounded-md border border-gray-a6 bg-gray-a2",
              "px-2.5 py-1 text-footnote text-gray-12",
              "focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus",
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
            <div className="flex flex-col gap-2 border-b border-gray-a4 p-1.5">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search positions…"
                className={cn(
                  "h-7 w-full rounded border border-gray-a6 bg-gray-a2 px-2 text-footnote",
                  "text-gray-12 placeholder:text-gray-a8 focus:outline-none focus:border-focus",
                )}
              />
              <label className="flex items-center gap-2 px-0.5 text-caption1 text-gray-11">
                <Switch checked={showOthers} onCheckedChange={setShowOthers} />
                Show positions from other service types
              </label>
            </div>
            <div
              role="listbox"
              aria-multiselectable="true"
              aria-label="Positions"
              className="max-h-72 overflow-y-auto pb-2"
            >
              {selected.length > 0 && (
                <div>
                  <GroupLabel>
                    Selected
                    <span className="font-normal normal-case tracking-normal text-gray-8">
                      {selected.length} · tick to remove
                    </span>
                  </GroupLabel>
                  {selected.map((p) => {
                    const tag = selectedTag(p.name);
                    return (
                      <PositionRow
                        key={`selected:${p.name}`}
                        label={p.name}
                        team={teamOf(p.name)}
                        checked
                        tag={tag ?? undefined}
                        tagTone="warn"
                        onClick={() => toggle(p.name)}
                      />
                    );
                  })}
                  <div className="my-1.5 h-px bg-gray-a4" />
                </div>
              )}
              {/* Any position — matches on the note alone, across every position. */}
              {anyVisible && (
                <PositionRow label="Any position" checked={entryFor(ANY) !== undefined} onClick={() => toggle(ANY)} />
              )}
              {teams.map((team) => (
                <div key={team}>
                  <GroupLabel>{team}</GroupLabel>
                  {teamRows
                    .filter((p) => p.teamName === team)
                    .map((p) => (
                      <PositionRow
                        key={`${p.teamId}:${p.positionName}`}
                        label={p.positionName}
                        checked={false}
                        onClick={() => toggle(p.positionName)}
                      />
                    ))}
                </div>
              ))}
              {here.isError && (
                <div className="px-2 py-2 text-caption1 text-gray-9">
                  Couldn't load this service type's positions.
                </div>
              )}
              {showOthers && all.isLoading && (
                <div className="px-2 py-2 text-caption1 text-gray-9">Loading other service types…</div>
              )}
              {showOthers && (all.isError || failedTypes.length > 0) && (
                <div className="px-2 py-2 text-caption1 text-gray-9">
                  {all.isError
                    ? "Couldn't load other service types."
                    : `Couldn't load: ${failedTypes.join(", ")}.`}
                </div>
              )}
              {otherTypes.map(({ typeName, rows }) => (
                <div key={typeName}>
                  <GroupLabel>
                    {typeName}
                    <span className="font-normal normal-case tracking-normal text-gray-8">other service type</span>
                  </GroupLabel>
                  {rows.map((p) => (
                    <PositionRow
                      key={`${p.serviceTypeId}:${p.teamId}:${p.positionName}`}
                      label={p.positionName}
                      team={p.teamName}
                      checked={false}
                      tag={typeName}
                      tagTone="type"
                      onClick={() => toggle(p.positionName)}
                    />
                  ))}
                </div>
              ))}
              {nothingToShow && !here.isError && (
                <div className="px-2 py-4 text-center text-caption1 text-gray-9">No positions found</div>
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
                <span className="flex-1 min-w-0 truncate text-right text-caption1 text-gray-11">
                  {positions.length === 1 ? "Note starts with" : (p.name ?? "Any position")}
                </span>
                <input
                  value={p.notesStartsWith ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setNote(key, e.target.value)}
                  placeholder="note"
                  aria-label={`Note filter for ${p.name ?? "any position"}`}
                  className={cn(
                    "h-7 w-24 shrink-0 rounded-md border border-gray-a6 bg-gray-a2 px-2 text-footnote",
                    "text-gray-12 placeholder:text-gray-a8 focus:outline-none focus:border-focus",
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

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-3 pt-2.5 pb-1 text-caption2 font-medium uppercase tracking-wide text-gray-9">
      {children}
    </div>
  );
}

function PositionRow({
  label,
  team,
  checked,
  tag,
  tagTone,
  onClick,
}: {
  label: string;
  team?: string;
  checked: boolean;
  tag?: string;
  tagTone?: "warn" | "type";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-footnote text-gray-12 hover:bg-gray-a3",
      )}
    >
      <CheckIcon className={cn("size-3.5 shrink-0", checked ? "opacity-100 text-accent" : "opacity-0")} />
      <span className="min-w-0 truncate">
        {label}
        {team && <span className="text-caption1 text-gray-9"> · {team}</span>}
      </span>
      {tag && (
        <span
          title={tag}
          className={cn(
            "ml-auto max-w-[45%] shrink-0 truncate rounded-full px-1.5 text-caption2 font-medium",
            tagTone === "warn" ? "bg-warn-2 text-warn-11" : "bg-gray-a3 text-gray-11",
          )}
        >
          {tag}
        </span>
      )}
    </button>
  );
}
