import { invoke, onNotification } from "../lib/api";
import { useState, useEffect, type ChangeEvent, type CSSProperties } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  SplitView,
  Sidebar,
  SidebarList,
  SidebarListItem,
  ScrollArea,
  Field,
  FieldSet,
  FieldGroup,
  FieldContent,
  FieldLabel,
  FieldDescription,
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  ButtonGroup,
  Separator,
  Switch,
  Dialog,
  toast,
} from "../components/ui";
import {
  PlusIcon,
  TrashIcon,
  Loader2Icon,
  RefreshCwIcon,
  GripVerticalIcon,
  BookmarkIcon,
  MonitorIcon,
  ExternalLinkIcon,
  CalendarIcon,
  LayersIcon,
  SlidersHorizontalIcon,
  PlugIcon,
  QrCodeIcon,
  Rows2Icon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IntegrationsPanel } from "../components/integrations-panel";
import { QrHint } from "../components/qr-hint";

// ---- helpers ----------------------------------------------------------------

function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

// ---- close on Escape --------------------------------------------------------

function useEscapeToClose() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      )
        return;
      if (document.querySelector("[data-radix-popper-content-wrapper]")) return;
      e.preventDefault();
      invoke("window:closeSettings");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

// ---- sidebar section definitions --------------------------------------------

type SectionId = "plan" | "service-types" | "displays" | "slots" | "integrations" | "connect";

interface SectionItem {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
}

const SECTIONS: SectionItem[] = [
  { id: "plan", label: "Plan", icon: <CalendarIcon className="size-4 text-gray-11" /> },
  { id: "service-types", label: "Service Types", icon: <LayersIcon className="size-4 text-gray-11" /> },
  { id: "displays", label: "Displays", icon: <MonitorIcon className="size-4 text-gray-11" /> },
  { id: "slots", label: "Slots", icon: <SlidersHorizontalIcon className="size-4 text-gray-11" /> },
  { id: "integrations", label: "Integrations", icon: <PlugIcon className="size-4 text-gray-11" /> },
  { id: "connect", label: "Connect", icon: <QrCodeIcon className="size-4 text-gray-11" /> },
];

// ---- slot row (sortable) ----------------------------------------------------

interface WirelessChannel {
  id: string;
  label: string;
}

interface SlotRowProps {
  slot: Slot;
  index: number;
  /** Position within a stacked column group, or null when not grouped. */
  groupPos: "top" | "middle" | "bottom" | null;
  wirelessChannels: WirelessChannel[];
  onChange: (updated: Slot) => void;
  onRemove: () => void;
}

function SlotRow({ slot, index, groupPos, wirelessChannels, onChange, onRemove }: SlotRowProps) {
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
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={onRemove}
          aria-label="Remove slot"
        >
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>

      {/* PCO-linked fields */}
      {isPco && (
        <div className="flex flex-col gap-1 pl-9">
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
              <Input
                value={
                  (slot.link as { kind: "pco"; matchBy: "position"; teamPositionName: string })
                    .teamPositionName
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onChange({
                    ...slot,
                    link: { kind: "pco", matchBy: "position", teamPositionName: e.target.value },
                  })
                }
                placeholder="e.g. Electric Guitar"
                className="flex-1 min-w-0"
              />
            ) : (
              <Input
                value={
                  (slot.link as { kind: "pco"; matchBy: "person"; personId: string }).personId
                }
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
          <Select
            value={slot.deviceBinding?.channelId ?? ""}
            onValueChange={setDeviceBinding}
          >
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

// ---- display row ------------------------------------------------------------

interface DisplayRowProps {
  display: DisplayInfo;
  isFirst: boolean;
  canRemove: boolean;
  onRename: (name: string) => void;
  onOpenWindow: () => void;
  onRemove: () => void;
}

function DisplayRow({ display, isFirst, canRemove, onRename, onOpenWindow, onRemove }: DisplayRowProps) {
  const [editName, setEditName] = useState(display.name);

  useEffect(() => {
    setEditName(display.name);
  }, [display.name]);

  function handleBlur() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== display.name) {
      onRename(trimmed);
    } else {
      setEditName(display.name);
    }
  }

  const displayUrl = `${window.location.origin}/?display=${encodeURIComponent(display.id)}`;

  return (
    <div className={`flex flex-col gap-1.5 py-2${isFirst ? "" : " border-t border-gray-a3"}`}>
      <div className="flex items-center gap-2">
        <MonitorIcon className="size-3.5 text-gray-9 shrink-0" />
        <Input
          value={editName}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
          onBlur={handleBlur}
          className="flex-1 min-w-0"
          aria-label="Display name"
        />
        <Button
          variant="filled"
          size="small"
          onClick={onOpenWindow}
          aria-label={`Open window for ${display.name}`}
        >
          <ExternalLinkIcon className="size-3.5 text-gray-9" />
          Open window
        </Button>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove display ${display.name}`}
        >
          <TrashIcon className="size-3.5 text-red-10" />
        </Button>
      </div>
      {/* URL hint — click to copy */}
      <button
        type="button"
        className="ml-5 text-left text-[11px] text-gray-a9 hover:text-gray-11 font-mono truncate transition-colors"
        title="Click to copy URL"
        onClick={() => navigator.clipboard.writeText(displayUrl).then(() => toast.success("URL copied"))}
      >
        {displayUrl}
      </button>
    </div>
  );
}

// ---- section content components ---------------------------------------------

interface SectionProps {
  stageState: StageState;
  serviceTypes: ServiceTypeDTO[];
  plans: PlanDTO[];
  wirelessChannels: WirelessChannel[];
  presets: SlotPreset[];
  selectedDisplayId: string;
  setSelectedDisplayId: (id: string) => void;
  localSlots: Slot[];
  slotsDirty: boolean;
  isSavingSlots: boolean;
  isRefreshing: boolean;
  presetName: string;
  setPresetName: (name: string) => void;
  isSavingPreset: boolean;
  handlers: {
    handleServiceTypeChange: (id: string) => Promise<void>;
    handlePlanModeChange: (mode: "auto" | "manual") => Promise<void>;
    handlePlanChange: (id: string) => Promise<void>;
    handleNextPlan: () => Promise<void>;
    handleRefresh: () => Promise<void>;
    handleShowQrChange: (show: boolean) => Promise<void>;
    handleSetAllowedServiceTypes: (ids: string[]) => Promise<void>;
    updateSlot: (idx: number, updated: Slot) => void;
    addSlot: () => void;
    removeSlot: (idx: number) => void;
    saveSlots: () => Promise<void>;
    handleSavePreset: () => Promise<void>;
    handleApplyPreset: (id: string) => Promise<void>;
    handleDeletePreset: (id: string) => Promise<void>;
    handleAddDisplay: () => Promise<void>;
    handleRenameDisplay: (id: string, name: string) => Promise<void>;
    handleRemoveDisplay: (id: string) => Promise<void>;
    handleOpenDisplayWindow: (id: string) => Promise<void>;
    handleDragEnd: (event: DragEndEvent) => void;
    sensors: ReturnType<typeof useSensors>;
  };
}

// ---- Plan section -----------------------------------------------------------

function PlanSection({ stageState, serviceTypes, plans, isRefreshing, handlers }: Pick<SectionProps, "stageState" | "serviceTypes" | "plans" | "isRefreshing" | "handlers">) {
  const allowed = stageState.allowedServiceTypeIds ?? [];
  const visibleServiceTypes = allowed.length === 0
    ? serviceTypes
    : serviceTypes.filter((st) => allowed.includes(st.id));

  return (
    <div className="px-5 flex flex-col gap-6 py-5">
      <FieldSet title="Plan Mode">
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Plan selection</FieldLabel>
              <FieldDescription>
                {stageState.planMode === "auto"
                  ? "Automatically follows the next upcoming event across your selected service types."
                  : "Manually choose a service type and plan."}
              </FieldDescription>
            </FieldContent>
            <ButtonGroup>
              <Button
                variant={stageState.planMode === "auto" ? "accent" : "filled"}
                size="small"
                onClick={() => handlers.handlePlanModeChange("auto")}
              >
                Auto
              </Button>
              <Button
                variant={stageState.planMode === "manual" ? "accent" : "filled"}
                size="small"
                onClick={() => handlers.handlePlanModeChange("manual")}
              >
                Manual
              </Button>
            </ButtonGroup>
          </Field>

          {/* Service type picker (manual only) */}
          {stageState.planMode === "manual" && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Service type</FieldLabel>
              </FieldContent>
              <Select
                value={stageState.serviceTypeId ?? ""}
                onValueChange={handlers.handleServiceTypeChange}
                disabled={visibleServiceTypes.length === 0}
              >
                <SelectTrigger className="w-52">
                  <SelectValue
                    placeholder={visibleServiceTypes.length === 0 ? "No types found" : "Select…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {visibleServiceTypes.map((st) => (
                    <SelectItem key={st.id} value={st.id}>
                      {st.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {/* Plan picker (manual only) */}
          {stageState.planMode === "manual" && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Plan</FieldLabel>
              </FieldContent>
              <Select
                value={stageState.planId ?? ""}
                onValueChange={handlers.handlePlanChange}
                disabled={plans.length === 0}
              >
                <SelectTrigger className="w-52">
                  <SelectValue
                    placeholder={plans.length === 0 ? "No plans found" : "Select plan…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                      {p.dates ? ` — ${p.dates}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {/* Active plan + next plan + refresh */}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Active plan</FieldLabel>
              {stageState.planTitle && (
                <FieldDescription>{stageState.planTitle}</FieldDescription>
              )}
            </FieldContent>
            <div className="flex items-center gap-2">
              {stageState.planMode === "auto" && (
                <Button variant="filled" size="small" onClick={handlers.handleNextPlan}>
                  Next plan
                </Button>
              )}
              <Button
                variant="filled"
                size="small"
                onClick={handlers.handleRefresh}
                disabled={isRefreshing}
                aria-label="Refresh from PCO"
              >
                {isRefreshing ? (
                  <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3.5 text-gray-9" />
                )}
                Refresh
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </FieldSet>
    </div>
  );
}

// ---- Service Types section --------------------------------------------------

function ServiceTypesSection({ stageState, serviceTypes, handlers }: Pick<SectionProps, "stageState" | "serviceTypes" | "handlers">) {
  const allowed = stageState.allowedServiceTypeIds ?? [];

  function toggle(id: string, checked: boolean) {
    let next: string[];
    if (allowed.length === 0) {
      // Currently all-allowed; switching one off means explicitly listing the others
      if (!checked) {
        next = serviceTypes.map((st) => st.id).filter((sid) => sid !== id);
      } else {
        // checked a type when previously all allowed — no-op (already on)
        next = [];
      }
    } else {
      if (checked) {
        next = [...allowed, id];
        // If all types are now checked, normalize to empty (all allowed)
        if (next.length === serviceTypes.length) next = [];
      } else {
        next = allowed.filter((sid) => sid !== id);
      }
    }
    handlers.handleSetAllowedServiceTypes(next).catch(() => {});
  }

  if (serviceTypes.length === 0) {
    return (
      <div className="px-5 py-5">
        <p className="text-body text-gray-9">
          Connect Planning Center in the Integrations section to see your service types.
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 flex flex-col gap-6 py-5">
      <FieldSet title="Allowed Service Types">
        <FieldGroup>
          {serviceTypes.map((st) => {
            const isOn = allowed.length === 0 || allowed.includes(st.id);
            return (
              <Field key={st.id} orientation="horizontal">
                <FieldContent>
                  <FieldLabel>{st.name}</FieldLabel>
                </FieldContent>
                <Switch
                  checked={isOn}
                  onCheckedChange={(v: boolean) => toggle(st.id, v)}
                  aria-label={`Allow ${st.name}`}
                />
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>
      <p className="text-caption1 text-gray-9">
        Auto plan mode follows only allowed types. The manual picker is also limited to these.
        Disabling all types is the same as allowing all.
      </p>
    </div>
  );
}

// ---- Displays section -------------------------------------------------------

function DisplaysSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  return (
    <div className="px-5 flex flex-col gap-4 py-5">
      <p className="text-caption1 text-gray-9">
        Each display runs in its own kiosk window with its own slot set. All displays share the
        same plan and PCO data.
      </p>

      <div className="flex flex-col">
        {(stageState.displays ?? []).map((display, idx) => (
          <DisplayRow
            key={display.id}
            display={display}
            isFirst={idx === 0}
            canRemove={(stageState.displays?.length ?? 1) > 1}
            onRename={(name) => handlers.handleRenameDisplay(display.id, name)}
            onOpenWindow={() => handlers.handleOpenDisplayWindow(display.id)}
            onRemove={() => handlers.handleRemoveDisplay(display.id)}
          />
        ))}
      </div>

      <Button variant="filled" size="small" onClick={handlers.handleAddDisplay} className="self-start">
        <PlusIcon className="size-3.5 text-gray-9" />
        Add display
      </Button>
    </div>
  );
}

// ---- Slots section ----------------------------------------------------------

function SlotsSection({
  stageState,
  wirelessChannels,
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
}: Pick<SectionProps, "stageState" | "wirelessChannels" | "presets" | "selectedDisplayId" | "setSelectedDisplayId" | "localSlots" | "slotsDirty" | "isSavingSlots" | "presetName" | "setPresetName" | "isSavingPreset" | "handlers">) {
  return (
    <div className="px-5 flex flex-col gap-6 py-5">
      {/* Display picker */}
      {(stageState.displays?.length ?? 0) > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-caption1 text-gray-9 shrink-0">Editing:</span>
          <Select value={selectedDisplayId} onValueChange={setSelectedDisplayId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select display…" />
            </SelectTrigger>
            <SelectContent>
              {(stageState.displays ?? []).map((d) => (
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
            <Button
              variant="accent"
              size="small"
              onClick={handlers.saveSlots}
              disabled={isSavingSlots}
            >
              {isSavingSlots ? (
                <Loader2Icon className="size-3.5 text-gray-9 animate-spin" />
              ) : null}
              Save slots
            </Button>
          )}
        </div>

        <DndContext
          sensors={handlers.sensors}
          collisionDetection={closestCenter}
          onDragEnd={handlers.handleDragEnd}
        >
          <SortableContext
            items={localSlots.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
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
          Slots are saved automatically per service type. Presets let you snapshot and restore
          any slot arrangement by name.
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

// ---- Integrations section ---------------------------------------------------

function IntegrationsSection() {
  return (
    <div className="px-5 py-5">
      <IntegrationsPanel />
    </div>
  );
}

// ---- Connect section --------------------------------------------------------

function ConnectSection({ stageState, handlers }: Pick<SectionProps, "stageState" | "handlers">) {
  return (
    <div className="px-5 flex flex-col gap-6 py-5">
      <FieldSet title="Remote Connection">
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>Show connect QR on display</FieldLabel>
              <FieldDescription>
                Displays the QR code and LAN URL in the kiosk top bar.
              </FieldDescription>
            </FieldContent>
            <Switch
              checked={stageState.showQr ?? false}
              onCheckedChange={handlers.handleShowQrChange}
            />
          </Field>

          {stageState.remoteUrl && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Connect a phone</FieldLabel>
                <FieldDescription>
                  Scan this code or open the address on a phone on the same network to control the
                  display remotely.
                </FieldDescription>
              </FieldContent>
              <QrHint url={stageState.remoteUrl} />
            </Field>
          )}
        </FieldGroup>
      </FieldSet>
    </div>
  );
}

// ---- main settings view -----------------------------------------------------

export function SettingsView() {
  useEscapeToClose();
  const queryClient = useQueryClient();

  const [activeSection, setActiveSection] = useState<SectionItem>(SECTIONS[0]);

  // Fetch current stage state
  const { data: stageState, isLoading: stageLoading } = useQuery({
    queryKey: ["stage:getState"],
    queryFn: () => ipc<StageState>("stage:getState"),
  });

  // Fetch all service types
  const { data: serviceTypes = [] } = useQuery({
    queryKey: ["stage:listServiceTypes"],
    queryFn: () => ipc<ServiceTypeDTO[]>("stage:listServiceTypes"),
  });

  // Fetch plans (depends on selected service type)
  const { data: plans = [] } = useQuery({
    queryKey: ["stage:listPlans", stageState?.serviceTypeId],
    queryFn: () =>
      stageState?.serviceTypeId
        ? ipc<PlanDTO[]>("stage:listPlans", { serviceTypeId: stageState.serviceTypeId })
        : Promise.resolve([]),
    enabled: !!stageState?.serviceTypeId,
  });

  // Fetch wireless channels
  const { data: wirelessChannels = [] } = useQuery({
    queryKey: ["wireless:listChannels"],
    queryFn: () => ipc<WirelessChannel[]>("wireless:listChannels"),
  });

  // Fetch presets
  const { data: presets = [] } = useQuery({
    queryKey: ["presets:list"],
    queryFn: () => ipc<SlotPreset[]>("presets:list"),
  });

  // Selected display for the slot editor (default to first display id)
  const [selectedDisplayId, setSelectedDisplayId] = useState<string>("");

  useEffect(() => {
    if (!stageState) return;
    const displays = stageState.displays ?? [];
    if (displays.length === 0) return;
    if (!selectedDisplayId || !displays.find((d) => d.id === selectedDisplayId)) {
      setSelectedDisplayId(displays[0].id);
    }
  }, [stageState, selectedDisplayId]);

  // Local slot editor state
  const [localSlots, setLocalSlots] = useState<Slot[]>([]);
  const [slotsDirty, setSlotsDirty] = useState(false);
  const [isSavingSlots, setIsSavingSlots] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Preset save dialog state
  const [presetName, setPresetName] = useState("");
  const [isSavingPreset, setIsSavingPreset] = useState(false);

  useEffect(() => {
    if (!stageState || slotsDirty) return;
    const displaySlots =
      stageState.slotsByDisplay?.[selectedDisplayId] ??
      (selectedDisplayId === (stageState.displays?.[0]?.id ?? "") ? stageState.slots : []);
    setLocalSlots([...displaySlots].sort((a, b) => a.order - b.order));
  }, [stageState, selectedDisplayId, slotsDirty]);

  // Subscribe to live state changes from backend
  useEffect(() => {
    const unsub = onNotification(
      "stage:state-changed",
      (payload: unknown) => {
        const s = payload as StageState;
        queryClient.setQueryData(["stage:getState"], s);
      },
    );
    return unsub;
  }, [queryClient]);

  // When Planning Center connects, refetch service types and plans
  useEffect(() => {
    const unsub = onNotification(
      "integrations:state-changed",
      (payload: unknown) => {
        const states = payload as IntegrationState[];
        const pco = states.find((s) => s.id === "planning-center");
        if (pco?.connection === "connected") {
          queryClient.invalidateQueries({ queryKey: ["stage:listServiceTypes"] });
          queryClient.invalidateQueries({ queryKey: ["stage:getState"] });
          queryClient.invalidateQueries({ queryKey: ["stage:listPlans"] });
        }
      },
    );
    return unsub;
  }, [queryClient]);

  // DnD sensors
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setLocalSlots((prev) => {
      const oldIndex = prev.findIndex((s) => s.id === active.id);
      const newIndex = prev.findIndex((s) => s.id === over.id);
      return arrayMove(prev, oldIndex, newIndex).map((s, i) => ({ ...s, order: i }));
    });
    setSlotsDirty(true);
  }

  async function handleServiceTypeChange(id: string) {
    try {
      const next = await ipc<StageState>("stage:setServiceType", { id });
      queryClient.setQueryData(["stage:getState"], next);
      queryClient.invalidateQueries({ queryKey: ["stage:listPlans"] });
    } catch (err) {
      toast.error(`Failed to set service type: ${String(err)}`);
    }
  }

  async function handlePlanModeChange(mode: "auto" | "manual") {
    try {
      const next = await ipc<StageState>("stage:setPlanMode", { mode });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to set plan mode: ${String(err)}`);
    }
  }

  async function handlePlanChange(id: string) {
    try {
      const next = await ipc<StageState>("stage:setPlan", { id });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to set plan: ${String(err)}`);
    }
  }

  async function handleNextPlan() {
    try {
      const next = await ipc<StageState>("stage:selectNextPlan");
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to select next plan: ${String(err)}`);
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      const next = await ipc<StageState>("stage:refresh");
      queryClient.setQueryData(["stage:getState"], next);
      toast.success("Refreshed from Planning Center.");
    } catch (err) {
      toast.error(`Refresh failed: ${String(err)}`);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleShowQrChange(show: boolean) {
    try {
      const next = await ipc<StageState>("stage:setShowQr", { show });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update QR setting: ${String(err)}`);
    }
  }

  async function handleSetAllowedServiceTypes(ids: string[]) {
    try {
      const next = await ipc<StageState>("stage:setAllowedServiceTypes", { ids });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update allowed service types: ${String(err)}`);
    }
  }

  function updateSlot(idx: number, updated: Slot) {
    setLocalSlots((prev) => {
      const next = [...prev];
      next[idx] = updated;
      return next;
    });
    setSlotsDirty(true);
  }

  function addSlot() {
    const newSlot: Slot = {
      id: `slot-${Date.now()}`,
      channel: String(localSlots.length + 1).padStart(2, "0"),
      order: localSlots.length,
      link: { kind: "pco", matchBy: "position", teamPositionName: "" },
      deviceBinding: null,
      displayName: null,
      photoUrl: null,
      device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null },
    };
    setLocalSlots((prev) => [...prev, newSlot]);
    setSlotsDirty(true);
  }

  function removeSlot(idx: number) {
    setLocalSlots((prev) =>
      prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i })),
    );
    setSlotsDirty(true);
  }

  async function saveSlots() {
    setIsSavingSlots(true);
    try {
      const slots = localSlots.map((s, i) => ({ ...s, order: i }));
      const next = await ipc<StageState>("stage:setSlots", { displayId: selectedDisplayId, slots });
      queryClient.setQueryData(["stage:getState"], next);
      setSlotsDirty(false);
      toast.success("Slots saved.");
    } catch (err) {
      toast.error(`Failed to save slots: ${String(err)}`);
    } finally {
      setIsSavingSlots(false);
    }
  }

  async function handleSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    setIsSavingPreset(true);
    try {
      const updated = await ipc<SlotPreset[]>("presets:save", {
        displayId: selectedDisplayId,
        name,
      });
      queryClient.setQueryData(["presets:list"], updated);
      setPresetName("");
      toast.success(`Preset "${name}" saved.`);
    } catch (err) {
      toast.error(`Failed to save preset: ${String(err)}`);
      throw err;
    } finally {
      setIsSavingPreset(false);
    }
  }

  async function handleApplyPreset(id: string) {
    try {
      const next = await ipc<StageState>("presets:apply", { displayId: selectedDisplayId, id });
      queryClient.setQueryData(["stage:getState"], next);
      const displaySlots =
        next.slotsByDisplay?.[selectedDisplayId] ??
        (selectedDisplayId === (next.displays?.[0]?.id ?? "") ? next.slots : []);
      setLocalSlots([...displaySlots].sort((a, b) => a.order - b.order));
      setSlotsDirty(false);
      toast.success("Preset applied.");
    } catch (err) {
      toast.error(`Failed to apply preset: ${String(err)}`);
    }
  }

  async function handleDeletePreset(id: string) {
    try {
      const updated = await ipc<SlotPreset[]>("presets:delete", { id });
      queryClient.setQueryData(["presets:list"], updated);
    } catch (err) {
      toast.error(`Failed to delete preset: ${String(err)}`);
    }
  }

  async function handleAddDisplay() {
    try {
      const next = await ipc<StageState>("displays:add", {});
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to add display: ${String(err)}`);
    }
  }

  async function handleRenameDisplay(id: string, name: string) {
    try {
      const next = await ipc<StageState>("displays:rename", { id, name });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to rename display: ${String(err)}`);
    }
  }

  async function handleRemoveDisplay(id: string) {
    try {
      const next = await ipc<StageState>("displays:remove", { id });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to remove display: ${String(err)}`);
    }
  }

  async function handleOpenDisplayWindow(id: string) {
    const url = `${window.location.origin}/?display=${encodeURIComponent(id)}`;
    window.open(url, `display-${id}`);
  }

  const handlers: SectionProps["handlers"] = {
    handleServiceTypeChange,
    handlePlanModeChange,
    handlePlanChange,
    handleNextPlan,
    handleRefresh,
    handleShowQrChange,
    handleSetAllowedServiceTypes,
    updateSlot,
    addSlot,
    removeSlot,
    saveSlots,
    handleSavePreset,
    handleApplyPreset,
    handleDeletePreset,
    handleAddDisplay,
    handleRenameDisplay,
    handleRemoveDisplay,
    handleOpenDisplayWindow,
    handleDragEnd,
    sensors,
  };

  if (stageLoading || !stageState) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2Icon className="size-5 text-gray-9 animate-spin" />
      </div>
    );
  }

  function renderSection() {
    if (!stageState) return null;
    switch (activeSection.id) {
      case "plan":
        return (
          <PlanSection
            stageState={stageState}
            serviceTypes={serviceTypes}
            plans={plans}
            isRefreshing={isRefreshing}
            handlers={handlers}
          />
        );
      case "service-types":
        return (
          <ServiceTypesSection
            stageState={stageState}
            serviceTypes={serviceTypes}
            handlers={handlers}
          />
        );
      case "displays":
        return <DisplaysSection stageState={stageState} handlers={handlers} />;
      case "slots":
        return (
          <SlotsSection
            stageState={stageState}
            wirelessChannels={wirelessChannels}
            presets={presets}
            selectedDisplayId={selectedDisplayId}
            setSelectedDisplayId={setSelectedDisplayId}
            localSlots={localSlots}
            slotsDirty={slotsDirty}
            isSavingSlots={isSavingSlots}
            presetName={presetName}
            setPresetName={setPresetName}
            isSavingPreset={isSavingPreset}
            handlers={handlers}
          />
        );
      case "integrations":
        return <IntegrationsSection />;
      case "connect":
        return <ConnectSection stageState={stageState} handlers={handlers} />;
    }
  }

  return (
    <SplitView
      storageKey="settings-view"
      sidebarSize={{ default: 200, min: 180, max: 240 }}
      sidebar={
        <Sidebar>
          <SidebarList
            items={SECTIONS}
            selectedItem={activeSection}
            onSelectedItemChange={setActiveSection}
            getItemKey={(s: SectionItem) => s.id}
          >
            {SECTIONS.map((section) => (
              <SidebarListItem
                key={section.id}
                item={section}
                icon={section.icon}
                title={section.label}
              />
            ))}
          </SidebarList>
        </Sidebar>
      }
    >
      <ScrollArea title={activeSection.label}>
        {renderSection()}
      </ScrollArea>
    </SplitView>
  );
}
