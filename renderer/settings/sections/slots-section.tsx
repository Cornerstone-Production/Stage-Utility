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
  Layers2Icon,
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
  InfoHint,
  toast,
  confirm,
} from "../../components/ui";
import { cn } from "../../lib/cn";
import type { SectionHandlers, WirelessChannel } from "../types";
import { PositionRangeEditor } from "./position-picker";
import { useStageState } from "../../main/use-stage-state";

// ---- slot row (sortable) ----------------------------------------------------

/** Canonical identity of a slot's positions set — mirrors positionSignature in
 *  main/services/slot-resolver.ts. Slots sharing one of these compete for distinct
 *  people, so the editor surfaces it; ticking one more position silently changes
 *  the grouping otherwise. null for slots that don't participate. */
function positionsSignature(slot: Slot): string | null {
  if (slot.link.kind !== "pco" || slot.link.matchBy !== "position") return null;
  if (slot.link.positions.length === 0) return null;
  return JSON.stringify(
    slot.link.positions
      .map((p) => [
        (p.name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase(),
        (p.notesStartsWith ?? "").trim().toLowerCase(),
      ] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  );
}

/** Build a "how many other slots share my set" lookup over the whole board. */
export function makeSharesWith(slots: Slot[]): (slot: Slot) => number {
  const counts = new Map<string, number>();
  for (const s of slots) {
    const sig = positionsSignature(s);
    if (sig) counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  return (slot: Slot) => {
    const sig = positionsSignature(slot);
    return sig ? (counts.get(sig) ?? 1) - 1 : 0;
  };
}


interface SlotRowProps {
  slot: Slot;
  index: number;
  /** True for a stacked slot that is not the first in its column — draws the
   *  rule separating it from the slot above inside the shared container. */
  stackDivider?: boolean;
  wirelessChannels: WirelessChannel[];
  teamPositions: TeamPositionDTO[];
  /** How many OTHER slots share this slot's exact positions set. Those slots
   *  compete for distinct people, which is otherwise invisible in the editor. */
  sharesWith: number;
  onChange: (updated: Slot) => void;
  onRemove: () => void;
  /** Drag-handle props from the owning sortable group (a whole stacked column is
   *  dragged as one unit, so grabbing any row in a group moves the whole group). */
  dragAttributes: DraggableAttributes;
  dragListeners: DraggableSyntheticListeners;
}

function SlotRow({ slot, index, stackDivider, wirelessChannels, teamPositions, sharesWith, onChange, onRemove, dragAttributes, dragListeners }: SlotRowProps) {
  const isPco = slot.link.kind === "pco";
  const isStatic = slot.link.kind === "static";
  const isEmpty = slot.link.kind === "empty";
  const isSpacer = slot.link.kind === "spacer";
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
        link: { kind: "pco", matchBy: "position", positions: [] },
      });
    }
  }

  function setPcoMatchBy(matchBy: "person" | "position") {
    if (matchBy === "person") {
      onChange({ ...slot, link: { kind: "pco", matchBy: "person", personId: "" } });
    } else {
      onChange({ ...slot, link: { kind: "pco", matchBy: "position", positions: [] } });
    }
  }

  function setDeviceBinding(channelId: string) {
    // "__none__" clears; "__offline__" switches to a per-slot manual label (no
    // live binding); anything else binds a live wireless channel. (Radix Select
    // forbids empty-string values, hence the sentinels.)
    if (channelId === "__offline__") {
      onChange({ ...slot, deviceBinding: null, deviceLabel: slot.deviceLabel ?? "" });
    } else if (!channelId || channelId === "__none__") {
      onChange({ ...slot, deviceBinding: null, deviceLabel: null });
    } else {
      // A live channel keeps any label already typed — the label stands in for the
      // frequency on the cell, so it is meaningful for live devices too, not just
      // offline ones.
      onChange({ ...slot, deviceBinding: { providerId: "wireless", channelId }, deviceLabel: slot.deviceLabel });
    }
  }

  function setIemBinding(channelId: string) {
    if (channelId === "__offline__") {
      onChange({ ...slot, iemBinding: null, iemLabel: slot.iemLabel ?? "" });
    } else if (!channelId || channelId === "__none__") {
      onChange({ ...slot, iemBinding: null, iemLabel: null });
    } else {
      onChange({ ...slot, iemBinding: { providerId: "wireless", channelId }, iemLabel: slot.iemLabel });
    }
  }

  const currentMode: "pco" | "static" | "empty" = isPco ? "pco" : isStatic ? "static" : "empty";

  // The receiver's own channel name, offered as a one-click fill for the mic label.
  // listChannels already uses CHAN_NAME as the channel's label (shure-base.ts), so
  // there is nothing extra to fetch — but it falls back to "Ch N" when the receiver
  // reports no name, and that is not worth putting on a display.
  const boundChannel = slot.deviceBinding
    ? wirelessChannels.find((c) => c.id === slot.deviceBinding!.channelId)
    : undefined;
  const receiverName =
    boundChannel && !/^Ch \d+$/.test(boundChannel.label) && boundChannel.label !== slot.deviceLabel
      ? boundChannel.label
      : null;

  // Collapsed-state hint for the "Options" drop-down — surfaces what's set so an
  // operator doesn't have to expand every slot to see its wiring.
  const optionParts: string[] = [];
  if (slot.deviceBinding) optionParts.push("mic");
  else if (slot.deviceLabel != null) optionParts.push("offline mic");
  if (slot.iemBinding) optionParts.push("IEM");
  else if (slot.iemLabel != null) optionParts.push("offline IEM");
  if ((slot.chargeSource ?? "mic") === "charger") optionParts.push("charger");
  else if (slot.chargeSource === "off") optionParts.push("no charge");
  if (slot.hideRf) optionParts.push("RF hidden");
  const optionsSummary = optionParts.length ? optionParts.join(" · ") : null;

  // Spacers are a horizontal gap for charger alignment — width + remove, plus an
  // optional empty-slot image centered in the gap.
  if (isSpacer) {
    return (
      <div className="relative flex flex-wrap items-center gap-2 py-3 pl-4 pr-3">
        <button
          {...dragAttributes}
          {...dragListeners}
          className="cursor-grab active:cursor-grabbing touch-pan-y p-0.5 shrink-0"
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
            className="w-32"
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
    <div
      className={cn(
        "relative flex flex-col gap-2 py-3 pl-4 pr-3",
        // Inside a stack container: inset from its edge, and ruled off from the
        // slot above so the members stay readable as separate slots.
        stackDivider && "border-t border-line",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Drag handle (drags the whole stacked group) */}
        <button
          {...dragAttributes}
          {...dragListeners}
          className="cursor-grab active:cursor-grabbing touch-pan-y p-0.5 shrink-0"
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
          tooltip={
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
          {/* Top-aligned, not centered: the position editor is a trigger with note
              rows under it, so centering pushed this select down beside the notes
              instead of level with the trigger it belongs to. */}
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
            {/* Mode select + its hint stay one row at every width. `self-center` on
                the hint alone put it on its own centred line once the parent wraps
                to a column on mobile. */}
            <div className="flex h-7 items-center gap-2 shrink-0">
              <InfoHint className="shrink-0">
                How this slot fills from Planning Center. By position: tick every position this slot may
                accept — the first one with someone available fills it, so a slot can cover acoustic OR
                electric week to week. Give a position a note to pin it to one person (e.g. &quot;1&quot; for the
                vocalist noted 1, &quot;HH&quot; for a handheld). Tick &quot;Any position&quot; to match on the note alone.
                By person ID: locks to one individual.
              </InfoHint>
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
            </div>

            {(slot.link as { kind: "pco"; matchBy: string }).matchBy === "position" ? (
              <PositionRangeEditor
                positions={(slot.link as { kind: "pco"; matchBy: "position"; positions: SlotPositionMatch[] }).positions}
                teamPositions={teamPositions}
                onChange={(positions) =>
                  onChange({ ...slot, link: { kind: "pco", matchBy: "position", positions } })
                }
              />
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
          {sharesWith > 0 && (
            <p className="text-caption2 text-gray-9">
              Shares people with {sharesWith} other slot{sharesWith === 1 ? "" : "s"} configured
              identically — each fills with a different person, in board order.
            </p>
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
          {/* Device channel — a live wireless channel, or "Offline" for a manual
              label (a networkless mic/pack, e.g. a PSM 900). Picking Offline
              reveals the label field; on the display it shows a pill in place of
              the RF pill. */}
          <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="flex items-center gap-1 text-caption1 text-gray-9 shrink-0">
              Device channel:
              <InfoHint>
                Bind this slot&apos;s mic to a live wireless channel (shows RF + battery), or pick Offline to
                just show a typed label for a networkless mic/pack. Offline shows a name pill in place of the
                RF bars.
              </InfoHint>
            </span>
            <Select
              value={slot.deviceBinding?.channelId ?? (slot.deviceLabel != null ? "__offline__" : "__none__")}
              onValueChange={setDeviceBinding}
            >
              <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                <SelectItem value="__offline__">Offline (manual label)</SelectItem>
                {wirelessChannels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>{ch.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(slot.deviceLabel != null || slot.deviceBinding != null) && (
            <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="flex items-center gap-1 text-caption1 text-gray-9 shrink-0">
                Mic label:
                <InfoHint>
                  Shown on the cell in place of the frequency. Leave blank to keep the frequency. On an
                  offline mic this is the whole pill, since there is no telemetry to show.
                </InfoHint>
              </span>
              <Input
                value={slot.deviceLabel ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...slot, deviceLabel: e.target.value })}
                placeholder="e.g. VOX 3"
                className="w-full sm:w-40"
              />
              {receiverName && (
                <Button
                  variant="transparent"
                  size="small"
                  onClick={() => onChange({ ...slot, deviceLabel: receiverName })}
                  tooltip={`Use the receiver's own channel name (${receiverName})`}
                >
                  Use receiver name
                </Button>
              )}
            </div>
          )}

          {/* IEM pack — a live channel (second battery bar) or "Offline" for a
              manual label. Available on any slot (vocalist, musician, etc.). */}
          <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="flex items-center gap-1 text-caption1 text-gray-9 shrink-0">
              IEM pack:
              <InfoHint>
                Adds a second battery bar for an in-ear pack. Pick a live channel, or Offline for a typed
                label. Available on any slot, not just vocals.
              </InfoHint>
            </span>
            <Select
              value={slot.iemBinding?.channelId ?? (slot.iemLabel != null ? "__offline__" : "__none__")}
              onValueChange={setIemBinding}
            >
              <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                <SelectItem value="__offline__">Offline (manual label)</SelectItem>
                {wirelessChannels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>{ch.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(slot.iemLabel != null || slot.iemBinding != null) && (
            <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="flex items-center gap-1 text-caption1 text-gray-9 shrink-0">
                IEM label:
                <InfoHint>
                  Shown on a second line under the mic label, so a player can see both their vocal mix
                  and their IEM mix on one cell. Leave blank to show nothing.
                </InfoHint>
              </span>
              <Input
                value={slot.iemLabel ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...slot, iemLabel: e.target.value })}
                placeholder="e.g. IEM 2"
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
            {/* Toggle + its hint stay one row at every width. `self-center` alone
                would center the hint on its own line once the parent wraps to a
                column on mobile. */}
            <div className="flex items-center gap-1.5 shrink-0">
              <label className="flex items-center gap-1.5 text-caption1 text-gray-9">
                <Switch checked={slot.hideRf ?? false} onCheckedChange={(v: boolean) => onChange({ ...slot, hideRf: v })} />
                Hide RF
              </label>
              <InfoHint>
                Hide the RF signal bars and show only the battery/charge level. Use for charge-only or IEM
                slots, or RF-silent setups.
              </InfoHint>
            </div>
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
  sharesWith,
  onChange,
  onRemove,
}: {
  slots: Slot[];
  startIndex: number;
  wirelessChannels: WirelessChannel[];
  teamPositions: TeamPositionDTO[];
  /** How many OTHER slots on the board share this slot's exact positions set. */
  sharesWith: (slot: Slot) => number;
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

  const rows = slots.map((slot, i) => {
    const index = startIndex + i;
    return (
      <SlotRow
        key={slot.id}
        slot={slot}
        index={index}
        // Rows after the first carry a rule, so the members of a stack read as
        // separate slots inside one column rather than one long run of fields.
        stackDivider={stacked && i > 0}
        wirelessChannels={wirelessChannels}
        teamPositions={teamPositions}
        sharesWith={sharesWith(slot)}
        onChange={(updated) => onChange(index, updated)}
        onRemove={() => onRemove(index)}
        dragAttributes={attributes}
        dragListeners={listeners}
      />
    );
  });

  return (
    <div ref={setNodeRef} style={style}>
      {stacked ? (
        // A stack IS one column sharing one charger, so it gets one container
        // rather than a bracket drawn beside its rows. The bracket had to be
        // positioned against a row whose height changes when Options open, so it
        // slid out of alignment the moment anything expanded; a container has no
        // geometry to keep in sync and cannot drift.
        // overflow-hidden so a row's divider stops at the rounded corner instead
        // of poking through it; my-2 so consecutive stacks are not flush against
        // each other and the list separator.
        <div className="my-2 overflow-hidden rounded-lg border border-line bg-surface-raised">
          <div className="flex items-center gap-1.5 px-3 pt-2">
            <Layers2Icon className="size-3 text-fg-subtle" />
            <span className="text-caption2 font-medium uppercase tracking-wide text-fg-subtle">
              Stacked
            </span>
            <span className="text-caption2 text-fg-muted">
              {slots.length} slots share one column
            </span>
          </div>
          {rows}
        </div>
      ) : (
        rows
      )}
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

  const sharesWith = makeSharesWith(localSlots);

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
                  sharesWith={sharesWith}
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
        className="cursor-grab active:cursor-grabbing touch-pan-y p-0.5 shrink-0"
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
        tooltip="Overwrite with current slots"
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
                className="w-32"
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
                className="w-32"
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
