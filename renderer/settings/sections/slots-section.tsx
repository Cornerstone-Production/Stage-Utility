import { type ChangeEvent, type CSSProperties } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PlusIcon,
  TrashIcon,
  Loader2Icon,
  GripVerticalIcon,
  BookmarkIcon,
  Rows2Icon,
} from "lucide-react";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  ButtonGroup,
  Separator,
  Dialog,
} from "../../components/ui";
import type { SectionProps, WirelessChannel } from "../types";
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
}

function SlotRow({ slot, index, groupPos, wirelessChannels, teamPositions, onChange, onRemove }: SlotRowProps) {
  const isPco = slot.link.kind === "pco";
  const isStatic = slot.link.kind === "static";
  const isEmpty = slot.link.kind === "empty";

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slot.id,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

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

  return (
    <div ref={setNodeRef} style={style} className="relative flex flex-col gap-2 py-3 pl-4">
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
      <div className="flex items-center gap-2">
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
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
        <div className="flex flex-col gap-1.5 pl-9">
          <div className="flex items-center gap-2">
            <Select
              value={(slot.link as { kind: "pco"; matchBy: string }).matchBy}
              onValueChange={(v: string) => setPcoMatchBy(v as "person" | "position")}
            >
              <SelectTrigger className="w-32">
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
            <div className="flex items-center gap-2">
              <span className="text-caption1 text-gray-9 shrink-0 w-32">Notes starts with:</span>
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
                className="w-24"
              />
            </div>
          )}
        </div>
      )}

      {/* Static label + color */}
      {isStatic && (
        <div className="flex items-center gap-2 pl-9">
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
        <div className="flex items-center gap-2 pl-9">
          <span className="text-caption1 text-gray-9 shrink-0">Device channel:</span>
          <Select value={slot.deviceBinding?.channelId ?? ""} onValueChange={setDeviceBinding}>
            <SelectTrigger className="w-40">
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

// ---- preset row -------------------------------------------------------------

interface PresetRowProps {
  preset: SlotPreset;
  onApply: () => void;
  onDelete: () => void;
}

function PresetRow({ preset, onApply, onDelete }: PresetRowProps) {
  return (
    <div className="flex items-center gap-2 py-2">
      <BookmarkIcon className="size-3.5 text-gray-7 shrink-0" />
      <span className="text-body text-gray-12 flex-1 min-w-0 truncate">{preset.name}</span>
      <span className="text-caption1 text-gray-8 shrink-0">
        {preset.slots.length} slot{preset.slots.length !== 1 ? "s" : ""}
      </span>
      <Button variant="filled" size="small" onClick={onApply}>
        Apply
      </Button>
      <Button variant="transparent" size="small" iconOnly onClick={onDelete} aria-label="Delete preset">
        <TrashIcon className="size-3.5 text-red-10" />
      </Button>
    </div>
  );
}

// ---- Slots section ----------------------------------------------------------

export function SlotsSection({
  stageState,
  wirelessChannels,
  teamPositions,
  presets,
  selectedDisplayId,
  setSelectedDisplayId,
  localSlots,
  slotsDirty,
  isSavingSlots,
  presetName,
  setPresetName,
  isSavingPreset,
  handlers,
}: Pick<
  SectionProps,
  | "stageState"
  | "wirelessChannels"
  | "teamPositions"
  | "presets"
  | "selectedDisplayId"
  | "setSelectedDisplayId"
  | "localSlots"
  | "slotsDirty"
  | "isSavingSlots"
  | "presetName"
  | "setPresetName"
  | "isSavingPreset"
  | "handlers"
>) {
  // Slots only apply to "slots"-kind displays — Dashboard/Stage/Captions render
  // their own fixed layouts and ignore slots, so don't let them be edited here.
  const slotDisplays = (stageState.displays ?? []).filter((d) => (d.kind ?? "slots") === "slots");

  if (slotDisplays.length === 0) {
    return (
      <div className="px-5 flex flex-col gap-2 py-5">
        <span className="text-headline font-semibold text-gray-12">Slots</span>
        <p className="text-caption1 text-gray-9">
          No slot-based displays. Set a display to <span className="font-medium text-gray-11">Slots</span> in
          the Displays section to assign microphone/team content.
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 flex flex-col gap-6 py-5">
      {/* Display picker — slots-kind displays only */}
      {slotDisplays.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-caption1 text-gray-9 shrink-0">Editing:</span>
          <Select value={selectedDisplayId} onValueChange={setSelectedDisplayId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select display…" />
            </SelectTrigger>
            <SelectContent>
              {slotDisplays.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Slot editor */}
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

        <DndContext
          sensors={handlers.sensors}
          collisionDetection={closestCenter}
          onDragEnd={handlers.handleDragEnd}
        >
          <SortableContext items={localSlots.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col">
              {localSlots.map((slot, idx) => {
                // Determine this slot's position within a stacked column group.
                const stacksPrev = idx > 0 && !!slot.stackWithPrevious;
                const nextStacks = !!localSlots[idx + 1]?.stackWithPrevious;
                const grouped = stacksPrev || nextStacks;
                const groupPos: "top" | "middle" | "bottom" | null = !grouped
                  ? null
                  : !stacksPrev
                    ? "top"
                    : !nextStacks
                      ? "bottom"
                      : "middle";
                return (
                  <div key={slot.id}>
                    {/* Separator between rows, but not within a stacked group */}
                    {idx > 0 && !stacksPrev && <Separator />}
                    <SlotRow
                      slot={slot}
                      index={idx}
                      groupPos={groupPos}
                      wirelessChannels={wirelessChannels}
                      teamPositions={teamPositions}
                      onChange={(updated) => handlers.updateSlot(idx, updated)}
                      onRemove={() => handlers.removeSlot(idx)}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>

        <Button variant="filled" size="small" onClick={handlers.addSlot} className="self-start">
          <PlusIcon className="size-3.5 text-gray-9" />
          Add slot
        </Button>
      </div>

      <Separator />

      {/* Presets */}
      <div className="flex flex-col gap-3">
        <span className="text-headline font-semibold text-gray-12">Presets</span>
        <p className="text-caption1 text-gray-9">
          Slots are saved automatically per service type. Presets let you snapshot and restore any
          slot arrangement by name.
        </p>

        <Dialog
          trigger={
            <Button variant="filled" size="small" className="self-start">
              Save current as preset
            </Button>
          }
          title="Save preset"
          description="Give this slot arrangement a name so you can restore it later."
          confirmLabel="Save"
          confirmDisabled={presetName.trim().length === 0 || isSavingPreset}
          onConfirm={handlers.handleSavePreset}
        >
          <Input
            value={presetName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPresetName(e.target.value)}
            placeholder="e.g. Sunday Morning"
            autoFocus
          />
        </Dialog>

        {presets.length > 0 ? (
          <div className="flex flex-col">
            {presets.map((preset, idx) => (
              <div key={preset.id}>
                {idx > 0 && <Separator />}
                <PresetRow
                  preset={preset}
                  onApply={() => handlers.handleApplyPreset(preset.id)}
                  onDelete={() => handlers.handleDeletePreset(preset.id)}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-caption1 text-gray-7">No presets saved yet.</p>
        )}
      </div>
    </div>
  );
}
