import { useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { DndContext, closestCenter, type DragEndEvent, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PlusIcon,
  TrashIcon,
  Loader2Icon,
  GripVerticalIcon,
  Rows2Icon,
  ImageIcon,
  BookmarkIcon,
  RotateCcwIcon,
  DownloadIcon,
  UploadIcon,
  SaveIcon,
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
  Collapsible,
  toast,
  confirm,
} from "../../components/ui";
import type { SectionHandlers, WirelessChannel } from "../types";
import { PositionPicker } from "./position-picker";
import { useStageState } from "../../main/use-stage-state";

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
  // IEM packs are a vocalist thing — only offer the second-bar picker on slots
  // bound to a Vocals position (matches the resolver's vocal gate).
  const isVocalSlot =
    slot.link.kind === "pco" &&
    slot.link.matchBy === "position" &&
    slot.link.teamPositionName.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase().includes("vocal");
  const chargerBays = useStageState().state?.chargerBays ?? [];

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
    // "__none__" is the sentinel for the "None" option — Radix Select forbids an
    // empty-string item value (it throws and crashes the settings tree), so map
    // the sentinel back to clearing the binding.
    if (!channelId || channelId === "__none__") {
      onChange({ ...slot, deviceBinding: null });
    } else {
      onChange({ ...slot, deviceBinding: { providerId: "wireless", channelId } });
    }
  }

  function setIemBinding(channelId: string) {
    if (!channelId || channelId === "__none__") {
      onChange({ ...slot, iemBinding: null });
    } else {
      onChange({ ...slot, iemBinding: { providerId: "wireless", channelId } });
    }
  }

  const currentMode: "pco" | "static" | "empty" = isPco ? "pco" : isStatic ? "static" : "empty";

  // Collapsed-state hint for the "Options" drop-down — surfaces what's set so an
  // operator doesn't have to expand every slot to see its wiring.
  const optionParts: string[] = [];
  if (slot.deviceBinding) optionParts.push("mic");
  if (slot.iemBinding) optionParts.push("IEM");
  if ((slot.chargeSource ?? "mic") === "charger") optionParts.push("charger");
  else if (slot.chargeSource === "off") optionParts.push("no charge");
  if (slot.hideRf) optionParts.push("RF hidden");
  const optionsSummary = optionParts.length ? optionParts.join(" · ") : null;

  // Spacers are a horizontal gap for charger alignment — width + remove, plus an
  // optional empty-slot image centered in the gap.
  if (isSpacer) {
    const showImage = (slot.link as { kind: "spacer"; showEmptyImage?: boolean }).showEmptyImage ?? false;
    return (
      <div className="relative flex flex-wrap items-center gap-2 py-3 pl-4">
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
        <label
          className="flex items-center gap-1.5 text-caption1 text-gray-9 shrink-0"
          title="Center the empty-slot image (from Branding) in this spacer"
        >
          <ImageIcon className="size-3.5 text-gray-9" />
          Image
          <Switch
            checked={showImage}
            onCheckedChange={(v: boolean) =>
              onChange({ ...slot, link: { kind: "spacer", showEmptyImage: v } })
            }
            aria-label="Show empty-slot image in spacer"
          />
        </label>
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

      {/* Extended options — collapsed by default so the row stays scannable.
          Everything after the PCO position/notes assignment lives in here. */}
      {!isEmpty && (
        <Collapsible label="Options" summary={optionsSummary} className="pl-4 sm:pl-9">
          {/* Device binding */}
          {wirelessChannels.length > 0 && (
            <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-caption1 text-gray-9 shrink-0">Device channel:</span>
              <Select value={slot.deviceBinding?.channelId ?? "__none__"} onValueChange={setDeviceBinding}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {wirelessChannels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id}>
                      {ch.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Offline/manual mic label override — only meaningful for a bound
              offline device (live mics show telemetry instead). */}
          {slot.deviceBinding && (
            <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-caption1 text-gray-9 shrink-0">Mic label:</span>
              <Input
                value={slot.deviceLabel ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...slot, deviceLabel: e.target.value || null })}
                placeholder="Offline devices only"
                className="w-full sm:w-40"
              />
            </div>
          )}

          {/* Optional second device (IEM/PSM pack) — adds a second battery bar
              beneath the primary. Vocalists only (handheld + IEM). */}
          {isVocalSlot && wirelessChannels.length > 0 && (
            <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-caption1 text-gray-9 shrink-0">IEM pack:</span>
              <Select value={slot.iemBinding?.channelId ?? "__none__"} onValueChange={setIemBinding}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {wirelessChannels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id}>
                      {ch.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-caption2 text-gray-8">Adds a second battery bar (headphones icon) for the pack.</span>
            </div>
          )}

          {/* Offline/manual IEM label override — shows a headphones-icon label
              when the IEM pack is an offline device (e.g. a PSM 900). */}
          {isVocalSlot && slot.iemBinding && (
            <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-caption1 text-gray-9 shrink-0">IEM label:</span>
              <Input
                value={slot.iemLabel ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...slot, iemLabel: e.target.value || null })}
                placeholder="Offline devices only"
                className="w-full sm:w-40"
              />
            </div>
          )}

          {/* Charge bar source: the bound mic's battery, a specific SBC charger
              bay, or off — plus a hide-RF (charge-only) toggle. */}
          <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="text-caption1 text-gray-9 shrink-0">Charge bar:</span>
            <Select
              value={slot.chargeSource ?? "mic"}
              onValueChange={(v: string) =>
                onChange({
                  ...slot,
                  chargeSource: v as "mic" | "charger" | "off",
                  chargeBayId: v === "charger" ? (slot.chargeBayId ?? null) : null,
                })
              }
            >
              <SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mic">Mic battery (transmitter)</SelectItem>
                <SelectItem value="charger">Charger bay</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
            {slot.chargeSource === "charger" && (
              <Select value={slot.chargeBayId ?? "__none__"} onValueChange={(v: string) => onChange({ ...slot, chargeBayId: v === "__none__" ? null : v })}>
                <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="Pick a bay" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {chargerBays.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {`${b.connectionName ?? `Charger ${b.chargerIndex}`} · Bay ${b.bay}${b.battery != null ? ` (${b.battery}%)` : ""}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <label className="flex items-center gap-1.5 text-caption1 text-gray-9 shrink-0">
              <Switch checked={slot.hideRf ?? false} onCheckedChange={(v: boolean) => onChange({ ...slot, hideRf: v })} />
              Hide RF
            </label>
          </div>
          <p className="text-caption2 text-gray-8">
            {slot.chargeSource === "off"
              ? "Charge bar hidden. The pill shows RF only."
              : slot.chargeSource === "charger"
                ? "Battery reads from the chosen SBC charger bay. Leave Hide RF off to show RF bars and the charge level together in one pill."
                : "Battery reads from the bound transmitter (e.g. the Axient handheld). Leave Hide RF off to show RF and battery together in one pill."}
          </p>
        </Collapsible>
      )}
    </div>
  );
}

// ---- Sortable stacked group -------------------------------------------------
// A stacked column (a lead slot + its `stackWithPrevious` followers) is ONE
// sortable unit, so dragging moves the whole group and never splits a stack.

export function SortableSlotGroup({
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
  slotPresets: SlotPreset[];
  handlers: Pick<
    SectionHandlers,
    | "updateSlot"
    | "addSlot"
    | "addSpacer"
    | "removeSlot"
    | "saveSlots"
    | "handleSetViewSlotsLayout"
    | "handleSavePreset"
    | "handleApplyPreset"
    | "handleDeletePreset"
    | "handleImportPreset"
    | "handleReorderPresets"
    | "handleRenamePreset"
    | "handleOverwritePreset"
    | "handleDragEnd"
    | "sensors"
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
  slotPresets,
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
        {slotsDirty && <span className="text-caption2 text-amber-10">Unsaved changes</span>}
        <Button
          variant="accent"
          size="small"
          onClick={handlers.saveSlots}
          disabled={isSavingSlots || !slotsDirty}
        >
          {isSavingSlots ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
          Save slots
        </Button>
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

      <PresetsPanel presets={slotPresets} localSlots={localSlots} handlers={handlers} />
    </div>
  );
}

// ---- Presets (saved slot arrangements) --------------------------------------

/** A slug safe for a download filename. */
function fileSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "arrangement";
}

/** Trigger a client-side JSON file download. */
function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Save / recall / export / import named slot arrangements. Presets are global —
 * saving captures the current view's slots; recall applies a preset to this view.
 */
export type PresetHandlers = Pick<
  SectionHandlers,
  | "handleSavePreset"
  | "handleApplyPreset"
  | "handleDeletePreset"
  | "handleImportPreset"
  | "handleReorderPresets"
  | "handleRenamePreset"
  | "handleOverwritePreset"
  | "sensors"
>;

/** One draggable preset row: grip + inline-rename + slots count + recall / overwrite / export / delete. */
function SortablePresetRow({ preset, handlers }: { preset: SlotPreset; handlers: PresetHandlers }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: preset.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const [editName, setEditName] = useState(preset.name);

  function commitName() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== preset.name) handlers.handleRenamePreset(preset.id, trimmed);
    else setEditName(preset.name);
  }

  return (
    <div ref={setNodeRef} style={style} className="flex flex-wrap items-center gap-2 py-2 border-t border-gray-a3 first:border-t-0">
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none p-0.5 shrink-0"
        aria-label="Drag to reorder"
        tabIndex={-1}
      >
        <GripVerticalIcon className="size-4 text-gray-7" />
      </button>
      <Input
        value={editName}
        data-preset-id={preset.id}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="flex-1 min-w-32 text-gray-12"
        aria-label={`Rename ${preset.name}`}
      />
      <span className="text-caption2 text-gray-9 shrink-0">{preset.slots.length} slots</span>
      <Button variant="filled" size="small" onClick={() => handlers.handleApplyPreset(preset.id)} aria-label={`Recall ${preset.name}`}>
        <RotateCcwIcon className="size-3.5 text-gray-9" />
        Recall
      </Button>
      <Button
        variant="transparent"
        size="small"
        iconOnly
        onClick={async () => {
          if (await confirm({ title: "Overwrite preset?", message: `Overwrite "${preset.name}" with the current slots?`, confirmLabel: "Overwrite" })) handlers.handleOverwritePreset(preset.id);
        }}
        aria-label={`Overwrite ${preset.name} with current slots`}
        title="Overwrite with current slots"
      >
        <SaveIcon className="size-3.5 text-gray-9" />
      </Button>
      <Button
        variant="transparent"
        size="small"
        iconOnly
        onClick={() => downloadJson(`${fileSlug(preset.name)}.slots.json`, { name: preset.name, slots: preset.slots })}
        aria-label={`Export ${preset.name}`}
      >
        <DownloadIcon className="size-3.5 text-gray-9" />
      </Button>
      <Button variant="transparent" size="small" iconOnly onClick={() => handlers.handleDeletePreset(preset.id)} aria-label={`Delete ${preset.name}`}>
        <TrashIcon className="size-3.5 text-red-10" />
      </Button>
    </div>
  );
}

export function PresetsPanel({
  presets,
  localSlots,
  handlers,
}: {
  presets: SlotPreset[];
  localSlots: Slot[];
  handlers: PresetHandlers;
}) {
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    handlers.handleSavePreset(trimmed);
    setName("");
  }

  function onPresetDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = presets.map((p) => p.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    handlers.handleReorderPresets(arrayMove(ids, oldIndex, newIndex));
  }

  function exportCurrent() {
    downloadJson("current.slots.json", { name: "Current slots", slots: localSlots });
  }

  async function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { name?: string; slots?: Slot[] } | Slot[];
      const slots = Array.isArray(parsed) ? parsed : parsed.slots;
      if (!Array.isArray(slots)) {
        toast.error("That file doesn't contain slots.");
        return;
      }
      const importedName =
        (!Array.isArray(parsed) && parsed.name) || file.name.replace(/\.slots\.json$|\.json$/i, "") || "Imported";
      await handlers.handleImportPreset(importedName, slots);
    } catch (err) {
      toast.error(`Couldn't read that file: ${String(err)}`);
    }
  }

  return (
    <div className="rounded-lg border border-gray-a4 p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <BookmarkIcon className="size-3.5 text-gray-9" />
        <span className="text-callout font-medium text-gray-12 flex-1">Saved arrangements</span>
      </div>

      {/* Save current slots as a new named preset */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder="Name this arrangement…"
          className="flex-1 min-w-40"
          aria-label="New arrangement name"
        />
        <Button variant="accent" size="small" onClick={save} disabled={!name.trim()}>
          <BookmarkIcon className="size-3.5" />
          Save current
        </Button>
      </div>

      {/* Saved presets list — drag to reorder, rename inline, overwrite/export/delete */}
      {presets.length > 0 ? (
        <DndContext sensors={handlers.sensors} collisionDetection={closestCenter} onDragEnd={onPresetDragEnd}>
          <SortableContext items={presets.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col">
              {presets.map((preset) => (
                <SortablePresetRow key={preset.id} preset={preset} handlers={handlers} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <p className="text-caption2 text-gray-9">
          No saved arrangements yet. Save the current slots above, then recall them into any view later.
        </p>
      )}

      {/* Export current / import from file */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="transparent" size="small" onClick={exportCurrent}>
          <DownloadIcon className="size-3.5 text-gray-9" />
          Export current
        </Button>
        <Button variant="transparent" size="small" onClick={() => fileRef.current?.click()}>
          <UploadIcon className="size-3.5 text-gray-9" />
          Import…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onImportFile}
          aria-hidden
        />
      </div>
    </div>
  );
}

/**
 * Physical-alignment controls for a slots-View: a toggle plus the monitor's active
 * width and default charger-column width (inches). When on, the kiosk sizes columns
 * in inches so they line up with the chargers; spacers fill the gaps/margins.
 */
export function AlignmentPanel({
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
