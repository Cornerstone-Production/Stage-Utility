import { type ChangeEvent, type CSSProperties } from "react";
import { DndContext, closestCenter, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PlusIcon,
  TrashIcon,
  Loader2Icon,
  GripVerticalIcon,
  Rows2Icon,
} from "lucide-react";
import {
  Button,
  Input,
  NumberInput,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  ButtonGroup,
  Separator,
  Switch,
} from "../../components/ui";
import type { SectionHandlers, WirelessChannel } from "../types";
import { PositionPicker } from "./position-picker";

// ---- slot row (sortable) ----------------------------------------------------

interface SlotRowProps {
  slot: Slot;
  index: number;
  /** Position within a stacked column group, or null when not grouped. */
  groupPos: "top" | "middle" | "bottom" | null;
  wirelessChannels: WirelessChannel[];
  teamPositions: TeamPositionDTO[];
  onChange: (updated: Slot) => void;
  onRemove: () => void;
  /** Drag-handle props from the owning sortable group (a whole stacked column is
   *  dragged as one unit, so grabbing any row in a group moves the whole group). */
  dragAttributes: DraggableAttributes;
  dragListeners: DraggableSyntheticListeners;
}

function SlotRow({ slot, index, groupPos, wirelessChannels, teamPositions, onChange, onRemove, dragAttributes, dragListeners }: SlotRowProps) {
  const isPco = slot.link.kind === "pco";
  const isStatic = slot.link.kind === "static";
  const isEmpty = slot.link.kind === "empty";
  const isSpacer = slot.link.kind === "spacer";

  function setChannel(channel: string) {
    onChange({ ...slot, channel });
  }

  function setMode(mode: "pco" | "static" | "empty") {
    if (mode === "static") {
      onChange({
        ...slot,
        link: { kind: "static", label: "", color: "#3b82f6" },
        displayName: null,
        photoUrl: null,
      });
    } else if (mode === "empty") {
      onChange({
        ...slot,
        link: { kind: "empty" },
        displayName: null,
        photoUrl: null,
      });
    } else {
      onChange({
        ...slot,
        link: { kind: "pco", matchBy: "position", teamPositionName: "" },
      });
    }
  }

  function setPcoMatchBy(matchBy: "person" | "position") {
    if (matchBy === "person") {
      onChange({ ...slot, link: { kind: "pco", matchBy: "person", personId: "" } });
    } else {
      onChange({ ...slot, link: { kind: "pco", matchBy: "position", teamPositionName: "" } });
    }
  }

  function setDeviceBinding(channelId: string) {
    if (!channelId) {
      onChange({ ...slot, deviceBinding: null });
    } else {
      onChange({ ...slot, deviceBinding: { providerId: "wireless", channelId } });
    }
  }

  const currentMode: "pco" | "static" | "empty" = isPco ? "pco" : isStatic ? "static" : "empty";

  // Spacers are a horizontal gap for charger alignment — just a width + remove.
  if (isSpacer) {
    return (
      <div className="relative flex items-center gap-2 py-3 pl-4">
        <button
          {...dragAttributes}
          {...dragListeners}
          className="cursor-grab active:cursor-grabbing touch-none p-0.5 shrink-0"
          aria-label="Drag to reorder"
          tabIndex={-1}
        >
          <GripVerticalIcon className="size-4 text-gray-7" />
        </button>
        <span className="text-callout text-gray-9 flex-1 italic">Spacer</span>
        <label className="flex items-center gap-1.5 text-caption1 text-gray-9 shrink-0">
          Width
          <NumberInput
            value={slot.widthIn ?? 2}
            step={0.5}
            min={0.1}
            suffix="in"
            className="w-24"
            aria-label="Spacer width (inches)"
            onChange={(n) => onChange({ ...slot, widthIn: n })}
          />
        </label>
        <Button variant="transparent" size="small" iconOnly onClick={onRemove} aria-label="Remove spacer">
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col gap-2 py-3 pl-4">
      {/* Group bracket — connects slots stacked into one column (shared charger) */}
      {groupPos && (
        <>
          <span
            className={`absolute left-1.5 w-[2px] rounded-full bg-gray-a7 pointer-events-none ${
              groupPos === "top"
                ? "top-1/2 bottom-0"
                : groupPos === "bottom"
                  ? "top-0 bottom-1/2"
                  : "top-0 bottom-0"
            }`}
          />
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-2 h-[2px] rounded-full bg-gray-a7 pointer-events-none" />
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* Drag handle (drags the whole stacked group) */}
        <button
          {...dragAttributes}
          {...dragListeners}
          className="cursor-grab active:cursor-grabbing touch-none p-0.5 shrink-0"
          aria-label="Drag to reorder"
          tabIndex={-1}
        >
          <GripVerticalIcon className="size-4 text-gray-7" />
        </button>

        {/* Channel input */}
        <Input
          value={slot.channel}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setChannel(e.target.value)}
          placeholder="01"
          className="w-14 tabular-nums"
          aria-label="Channel"
        />

        {/* Mode toggle: PCO / Static / Empty */}
        <ButtonGroup>
          <Button
            variant={currentMode === "pco" ? "accent" : "filled"}
            size="small"
            onClick={() => setMode("pco")}
          >
            PCO
          </Button>
          <Button
            variant={currentMode === "static" ? "accent" : "filled"}
            size="small"
            onClick={() => setMode("static")}
          >
            Static
          </Button>
          <Button
            variant={currentMode === "empty" ? "accent" : "filled"}
            size="small"
            onClick={() => setMode("empty")}
          >
            Empty
          </Button>
        </ButtonGroup>

        <div className="flex-1 min-w-0" />

        {/* Stack with previous — groups this slot into the column above (rows),
            mirroring a dual-bay charger shared by two people. */}
        <Button
          variant={slot.stackWithPrevious ? "accent" : "filled"}
          size="small"
          disabled={index === 0}
          onClick={() => onChange({ ...slot, stackWithPrevious: !slot.stackWithPrevious })}
          aria-label="Stack into the column above"
          title={
            index === 0
              ? "The first slot can't stack onto a previous one"
              : "Stack into the same column as the slot above (shared charger)"
          }
        >
          <Rows2Icon className="size-3.5" />
          Stack
        </Button>

        {/* Remove */}
        <Button variant="transparent" size="small" iconOnly onClick={onRemove} aria-label="Remove slot">
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>

      {/* PCO-linked fields */}
      {isPco && (
        <div className="flex flex-col gap-1.5 pl-4 sm:pl-9">
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <Select
              value={(slot.link as { kind: "pco"; matchBy: string }).matchBy}
              onValueChange={(v: string) => setPcoMatchBy(v as "person" | "position")}
            >
              <SelectTrigger className="w-full sm:w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="position">By position</SelectItem>
                <SelectItem value="person">By person ID</SelectItem>
              </SelectContent>
            </Select>

            {(slot.link as { kind: "pco"; matchBy: string }).matchBy === "position" ? (
              teamPositions.length > 0 ? (
                <PositionPicker
                  value={
                    (slot.link as { kind: "pco"; matchBy: "position"; teamPositionName: string })
                      .teamPositionName || ""
                  }
                  teamPositions={teamPositions}
                  onChange={(v) =>
                    onChange({
                      ...slot,
                      link: {
                        kind: "pco",
                        matchBy: "position",
                        teamPositionName: v,
                        notesStartsWith: (slot.link as { kind: "pco"; matchBy: "position"; notesStartsWith?: string }).notesStartsWith,
                      },
                    })
                  }
                />
              ) : (
                <Input
                  value={
                    (slot.link as { kind: "pco"; matchBy: "position"; teamPositionName: string })
                      .teamPositionName
                  }
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    onChange({
                      ...slot,
                      link: {
                        kind: "pco",
                        matchBy: "position",
                        teamPositionName: e.target.value,
                        notesStartsWith: (slot.link as { kind: "pco"; matchBy: "position"; notesStartsWith?: string }).notesStartsWith,
                      },
                    })
                  }
                  placeholder="e.g. Electric Guitar"
                  className="flex-1 min-w-0"
                />
              )
            ) : (
              <Input
                value={(slot.link as { kind: "pco"; matchBy: "person"; personId: string }).personId}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onChange({
                    ...slot,
                    link: { kind: "pco", matchBy: "person", personId: e.target.value },
                  })
                }
                placeholder="PCO Person ID"
                className="flex-1 min-w-0"
              />
            )}
          </div>
          {/* Notes starts-with filter — only shown for "by position" */}
          {(slot.link as { kind: "pco"; matchBy: string }).matchBy === "position" && (
            <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-caption1 text-gray-9 shrink-0 sm:w-32">Notes starts with:</span>
              <Input
                value={
                  (slot.link as { kind: "pco"; matchBy: "position"; notesStartsWith?: string })
                    .notesStartsWith ?? ""
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onChange({
                    ...slot,
                    link: {
                      kind: "pco",
                      matchBy: "position",
                      teamPositionName: (slot.link as { kind: "pco"; matchBy: "position"; teamPositionName: string }).teamPositionName,
                      notesStartsWith: e.target.value || undefined,
                    },
                  })
                }
                placeholder="e.g. 1  or  HH"
                className="w-full sm:w-24"
              />
            </div>
          )}
        </div>
      )}

      {/* Static label + color */}
      {isStatic && (
        <div className="flex items-center gap-2 pl-4 sm:pl-9">
          <Input
            value={(slot.link as { kind: "static"; label: string; color: string }).label}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onChange({
                ...slot,
                link: {
                  kind: "static",
                  label: e.target.value,
                  color: (slot.link as { kind: "static"; label: string; color: string }).color,
                },
              })
            }
            placeholder="Label (e.g. Backup)"
            className="flex-1 min-w-0"
          />
          <input
            type="color"
            value={(slot.link as { kind: "static"; label: string; color: string }).color}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onChange({
                ...slot,
                link: {
                  kind: "static",
                  label: (slot.link as { kind: "static"; label: string; color: string }).label,
                  color: e.target.value,
                },
              })
            }
            className="w-9 h-8 rounded cursor-pointer border border-gray-a4 bg-transparent"
            aria-label="Panel color"
          />
        </div>
      )}

      {/* Device binding (optional, not shown for empty slots) */}
      {!isEmpty && wirelessChannels.length > 0 && (
        <div className="flex flex-col items-stretch gap-1.5 pl-4 sm:pl-9 sm:flex-row sm:items-center sm:gap-2">
          <span className="text-caption1 text-gray-9 shrink-0">Device channel:</span>
          <Select value={slot.deviceBinding?.channelId ?? ""} onValueChange={setDeviceBinding}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">None</SelectItem>
              {wirelessChannels.map((ch) => (
                <SelectItem key={ch.id} value={ch.id}>
                  {ch.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

// ---- Sortable stacked group -------------------------------------------------
// A stacked column (a lead slot + its `stackWithPrevious` followers) is ONE
// sortable unit, so dragging moves the whole group and never splits a stack.

function SortableSlotGroup({
  slots,
  startIndex,
  wirelessChannels,
  teamPositions,
  onChange,
  onRemove,
}: {
  slots: Slot[];
  startIndex: number;
  wirelessChannels: WirelessChannel[];
  teamPositions: TeamPositionDTO[];
  onChange: (index: number, updated: Slot) => void;
  onRemove: (index: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slots[0].id,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const stacked = slots.length > 1;

  return (
    <div ref={setNodeRef} style={style}>
      {slots.map((slot, i) => {
        const index = startIndex + i;
        const groupPos: "top" | "middle" | "bottom" | null = !stacked
          ? null
          : i === 0
            ? "top"
            : i === slots.length - 1
              ? "bottom"
              : "middle";
        return (
          <SlotRow
            key={slot.id}
            slot={slot}
            index={index}
            groupPos={groupPos}
            wirelessChannels={wirelessChannels}
            teamPositions={teamPositions}
            onChange={(updated) => onChange(index, updated)}
            onRemove={() => onRemove(index)}
            dragAttributes={attributes}
            dragListeners={listeners}
          />
        );
      })}
    </div>
  );
}

// ---- Slot editor (embedded in the Views tab) --------------------------------

interface SlotEditorProps {
  view: View;
  wirelessChannels: WirelessChannel[];
  teamPositions: TeamPositionDTO[];
  localSlots: Slot[];
  slotsDirty: boolean;
  isSavingSlots: boolean;
  handlers: Pick<
    SectionHandlers,
    "updateSlot" | "addSlot" | "addSpacer" | "removeSlot" | "saveSlots" | "handleSetViewSlotsLayout" | "handleDragEnd" | "sensors"
  >;
}

/** The drag-sortable slot list + Add/Save controls, reused by the Views editor. */
export function SlotEditor({
  view,
  wirelessChannels,
  teamPositions,
  localSlots,
  slotsDirty,
  isSavingSlots,
  handlers,
}: SlotEditorProps) {
  const layout = view.slotsLayout ?? null;

  // Group slots into stacked columns (a lead slot + its `stackWithPrevious`
  // followers). Each group is dragged as a single sortable unit.
  const groups: { slots: Slot[]; start: number }[] = [];
  localSlots.forEach((slot, i) => {
    if (slot.stackWithPrevious && groups.length > 0) groups[groups.length - 1].slots.push(slot);
    else groups.push({ slots: [slot], start: i });
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-headline font-semibold text-gray-12 flex-1">Slots</span>
        {slotsDirty && (
          <Button variant="accent" size="small" onClick={handlers.saveSlots} disabled={isSavingSlots}>
            {isSavingSlots ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
            Save slots
          </Button>
        )}
      </div>

      <AlignmentPanel
        layout={layout}
        slots={localSlots}
        onChange={(next) => handlers.handleSetViewSlotsLayout(view.id, next)}
      />

      <DndContext
        sensors={handlers.sensors}
        collisionDetection={closestCenter}
        onDragEnd={handlers.handleDragEnd}
      >
        <SortableContext items={groups.map((g) => g.slots[0].id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col">
            {groups.map((g, gi) => (
              <div key={g.slots[0].id}>
                {/* Separator between groups (never within a stacked column) */}
                {gi > 0 && <Separator />}
                <SortableSlotGroup
                  slots={g.slots}
                  startIndex={g.start}
                  wirelessChannels={wirelessChannels}
                  teamPositions={teamPositions}
                  onChange={handlers.updateSlot}
                  onRemove={handlers.removeSlot}
                />
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap gap-2">
        <Button variant="filled" size="small" onClick={handlers.addSlot}>
          <PlusIcon className="size-3.5 text-gray-9" />
          Add slot
        </Button>
        <Button variant="filled" size="small" onClick={handlers.addSpacer}>
          <PlusIcon className="size-3.5 text-gray-9" />
          Add spacer
        </Button>
      </div>
    </div>
  );
}

/**
 * Physical-alignment controls for a slots-View: a toggle plus the monitor's active
 * width and default charger-column width (inches). When on, the kiosk sizes columns
 * in inches so they line up with the chargers; spacers fill the gaps/margins.
 */
function AlignmentPanel({
  layout,
  slots,
  onChange,
}: {
  layout: SlotsLayout | null;
  slots: Slot[];
  onChange: (next: SlotsLayout | null) => void;
}) {
  const DEFAULT: SlotsLayout = { displayWidthIn: 32.25, columnWidthIn: 3.49 };
  const enabled = !!layout;

  // Sum of column widths in inches (chargers use their override or the default;
  // spacers use their own width) — to warn when the row exceeds the display.
  let usedIn = 0;
  if (layout) {
    const sorted = [...slots].sort((a, b) => a.order - b.order);
    for (const s of sorted) {
      if (s.stackWithPrevious) continue; // only the lead slot of a column counts
      usedIn += s.widthIn ?? layout.columnWidthIn;
    }
  }
  const over = layout ? usedIn > layout.displayWidthIn + 0.01 : false;

  return (
    <div className="rounded-lg border border-gray-a4 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-callout font-medium text-gray-12 flex-1">Align to physical chargers</span>
        <Switch checked={enabled} onCheckedChange={(v: boolean) => onChange(v ? DEFAULT : null)} />
      </div>
      {layout && (
        <>
          <p className="text-caption2 text-gray-9 leading-snug">
            Columns are sized in inches against the monitor's active width, so slots line up with the
            chargers below. Add spacers for the gaps between charger banks and the side margins.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5 text-caption1 text-gray-11">
              Display width
              <NumberInput
                value={layout.displayWidthIn}
                step={0.25}
                min={1}
                suffix="in"
                className="w-28"
                aria-label="Display active width (inches)"
                onChange={(n) => onChange({ ...layout, displayWidthIn: n })}
              />
            </label>
            <label className="flex items-center gap-1.5 text-caption1 text-gray-11">
              Charger width
              <NumberInput
                value={layout.columnWidthIn}
                step={0.1}
                min={0.1}
                suffix="in"
                className="w-28"
                aria-label="Charger column width (inches)"
                onChange={(n) => onChange({ ...layout, columnWidthIn: n })}
              />
            </label>
          </div>
          <p className={`text-caption2 ${over ? "text-red-10" : "text-gray-9"}`}>
            Using {usedIn.toFixed(2)}″ of {layout.displayWidthIn.toFixed(2)}″
            {over ? " — over the display width; reduce widths or spacers." : ""}
          </p>
        </>
      )}
    </div>
  );
}
