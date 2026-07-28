import { useState, useEffect } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { Button, Select, SelectTrigger, SelectContent, SelectItem, SelectValue, Separator, toast } from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStageState } from "../../main/use-stage-state";
import { SortableSlotGroup, AlignmentPanel, PresetsPanel, makeSharesWith, type PresetHandlers } from "./slots-section";
import type { WirelessChannel } from "../types";

function freshSlotId(): string {
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
const EMPTY_DEVICE: SlotDevice = { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null };

/**
 * The full mic-slots editor for an INLINE `slots-grid` layout object, rendered
 * below the layout canvas. Owns the object's own slot set (per active service
 * type, keyed by the object id on the server) and reuses the same slot row /
 * alignment / preset components as the slots-View editor. Physical-inch alignment
 * is stored on the object's config (saved with the layout); the slots themselves
 * save with their own "Save slots" button, per service type.
 */
export function InlineSlotsEditor({
  objectId,
  slotsLayout,
  onSetLayout,
}: {
  objectId: string;
  slotsLayout: SlotsLayout | null;
  onSetLayout: (next: SlotsLayout | null) => void;
}) {
  const { state } = useStageState();
  const queryClient = useQueryClient();
  const serviceTypeId = state?.serviceTypeId ?? null;
  const pcoConfigured = !!state?.pcoConfigured;

  const { data: wirelessChannels = [] } = useQuery({
    queryKey: ["wireless:listChannels"],
    queryFn: () => ipc<WirelessChannel[]>("wireless:listChannels"),
  });
  const { data: teamPositions = [] } = useQuery({
    queryKey: ["stage:listTeamPositions", serviceTypeId],
    queryFn: () => ipc<TeamPositionDTO[]>("stage:listTeamPositions"),
    enabled: !!serviceTypeId && pcoConfigured,
  });
  const { data: slotPresets = [] } = useQuery({
    queryKey: ["presets:list"],
    queryFn: () => ipc<SlotPreset[]>("presets:list"),
  });

  const [localSlots, setLocalSlots] = useState<Slot[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Mirror this object's resolved slots into the editor (unless mid-edit). Re-seeds
  // when the object or active service type changes (state carries both).
  useEffect(() => {
    if (dirty) return;
    const slots = state?.slotsByLayoutObject?.[objectId] ?? [];
    setLocalSlots([...slots].sort((a, b) => a.order - b.order));
  }, [state, objectId, dirty]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function updateSlot(idx: number, updated: Slot) {
    setLocalSlots((prev) => prev.map((s, i) => (i === idx ? updated : s)));
    setDirty(true);
  }
  function addSlot() {
    const maxChannel = localSlots.reduce((max, s) => {
      const n = Number.parseInt(s.channel, 10);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    const slot: Slot = {
      id: freshSlotId(),
      channel: String(maxChannel + 1).padStart(2, "0"),
      order: localSlots.length,
      link: { kind: "pco", matchBy: "position", positions: [] },
      deviceBinding: null,
      displayName: null,
      photoUrl: null,
      device: { ...EMPTY_DEVICE },
    };
    setLocalSlots((prev) => [...prev, slot]);
    setDirty(true);
  }
  function addSpacer() {
    const slot: Slot = {
      id: freshSlotId(),
      channel: "",
      order: localSlots.length,
      link: { kind: "spacer" },
      widthIn: 2,
      deviceBinding: null,
      displayName: null,
      photoUrl: null,
      device: { ...EMPTY_DEVICE },
    };
    setLocalSlots((prev) => [...prev, slot]);
    setDirty(true);
  }
  function removeSlot(idx: number) {
    setLocalSlots((prev) => {
      const next = prev.map((s) => ({ ...s }));
      if (next[idx + 1]?.stackWithPrevious) next[idx + 1] = { ...next[idx + 1], stackWithPrevious: false };
      return next.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i }));
    });
    setDirty(true);
  }
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setLocalSlots((prev) => {
      const groups: Slot[][] = [];
      for (const s of prev) {
        if (s.stackWithPrevious && groups.length > 0) groups[groups.length - 1].push(s);
        else groups.push([s]);
      }
      const oldIndex = groups.findIndex((g) => g[0].id === active.id);
      const newIndex = groups.findIndex((g) => g[0].id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(groups, oldIndex, newIndex).flat().map((s, i) => ({ ...s, order: i }));
    });
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const slots = localSlots.map((s, i) => ({ ...s, order: i }));
      const next = await ipc<StageState>("layoutObjects:setSlots", { id: objectId, slots });
      queryClient.setQueryData(["stage:getState"], next);
      setDirty(false);
      toast.success("Slots saved.");
    } catch (err) {
      toast.error(`Failed to save slots: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // Copy a slots-View's lineup into this grid as a starting point (fresh ids).
  // Also carry over the source view's physical-inch alignment so the columns line
  // up the same way — otherwise spacer columns render full-width and spread out.
  const slotsViews = (state?.views ?? []).filter((v) => v.kind === "slots");
  function seedFromView(viewId: string) {
    const view = slotsViews.find((v) => v.id === viewId);
    const src = state?.slotsByView?.[viewId] ?? [];
    setLocalSlots(src.map((s, i) => ({ ...s, id: freshSlotId(), order: i })));
    onSetLayout(view?.slotsLayout ?? null);
    setDirty(true);
  }

  // Preset handlers wired for an inline grid: apply is client-side (recall into the
  // local set); save/overwrite capture the on-screen slots directly; delete/rename/
  // reorder/import are the shared global library ops.
  const presetHandlers: PresetHandlers = {
    sensors,
    handleApplyPreset: async (id: string) => {
      const preset = slotPresets.find((p) => p.id === id);
      if (!preset) return;
      setLocalSlots(preset.slots.map((s, i) => ({ ...s, id: freshSlotId(), order: i })));
      setDirty(true);
      toast.success("Arrangement applied — Save slots to keep it.");
    },
    handleSavePreset: async (name: string) => {
      try {
        const presets = await ipc<SlotPreset[]>("presets:import", { name, slots: localSlots });
        queryClient.setQueryData(["presets:list"], presets);
        toast.success(`Saved arrangement "${name}".`);
      } catch (err) {
        toast.error(`Failed to save arrangement: ${String(err)}`);
      }
    },
    handleOverwritePreset: async (id: string) => {
      try {
        const presets = await ipc<SlotPreset[]>("presets:overwrite", { id, slots: localSlots });
        queryClient.setQueryData(["presets:list"], presets);
        toast.success("Arrangement overwritten with current slots.");
      } catch (err) {
        toast.error(`Failed to overwrite arrangement: ${String(err)}`);
      }
    },
    handleDeletePreset: async (id: string) => {
      try {
        queryClient.setQueryData(["presets:list"], await ipc<SlotPreset[]>("presets:delete", { id }));
      } catch (err) {
        toast.error(`Failed to delete arrangement: ${String(err)}`);
      }
    },
    handleImportPreset: async (name: string, slots: Slot[]) => {
      try {
        queryClient.setQueryData(["presets:list"], await ipc<SlotPreset[]>("presets:import", { name, slots }));
        toast.success(`Imported arrangement "${name}".`);
      } catch (err) {
        toast.error(`Failed to import arrangement: ${String(err)}`);
      }
    },
    handleRenamePreset: async (id: string, name: string) => {
      try {
        queryClient.setQueryData(["presets:list"], await ipc<SlotPreset[]>("presets:rename", { id, name }));
      } catch (err) {
        toast.error(`Failed to rename arrangement: ${String(err)}`);
      }
    },
    handleReorderPresets: async (ids: string[]) => {
      try {
        queryClient.setQueryData(["presets:list"], await ipc<SlotPreset[]>("presets:reorder", { ids }));
      } catch (err) {
        toast.error(`Failed to reorder arrangements: ${String(err)}`);
      }
    },
  };

  // Group slots into stacked columns (lead + its `stackWithPrevious` followers).
  const groups: { slots: Slot[]; start: number }[] = [];
  localSlots.forEach((slot, i) => {
    if (slot.stackWithPrevious && groups.length > 0) groups[groups.length - 1].slots.push(slot);
    else groups.push({ slots: [slot], start: i });
  });

  const sharesWith = makeSharesWith(localSlots);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-headline font-semibold text-gray-12 flex-1">Mic slots</span>
        {!serviceTypeId && <span className="text-caption2 text-amber-10">Pick a service type to edit slots</span>}
        {dirty && serviceTypeId && <span className="text-caption2 text-amber-10">Unsaved changes</span>}
        <Button variant="accent" size="small" onClick={save} disabled={saving || !dirty || !serviceTypeId}>
          {saving ? <Loader2Icon className="size-3.5 text-gray-9 animate-spin" /> : null}
          Save slots
        </Button>
      </div>

      {slotsViews.length > 0 && (
        <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <span className="text-caption1 text-gray-9 shrink-0">Seed from view:</span>
          <Select value="" onValueChange={(id: string) => { if (id) seedFromView(id); }}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Copy a slots view's lineup…" /></SelectTrigger>
            <SelectContent>
              {slotsViews.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      <AlignmentPanel layout={slotsLayout} slots={localSlots} onChange={onSetLayout} />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={groups.map((g) => g.slots[0].id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col">
            {groups.map((g, gi) => (
              <div key={g.slots[0].id}>
                {gi > 0 && <Separator />}
                <SortableSlotGroup
                  slots={g.slots}
                  startIndex={g.start}
                  wirelessChannels={wirelessChannels}
                  teamPositions={teamPositions}
                  sharesWith={sharesWith}
                  onChange={updateSlot}
                  onRemove={removeSlot}
                />
              </div>
            ))}
            {localSlots.length === 0 && <span className="text-caption2 text-gray-7 py-2">No slots yet — add one below.</span>}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex flex-wrap gap-2">
        <Button variant="filled" size="small" onClick={addSlot}>
          <PlusIcon className="size-3.5 text-gray-9" /> Add slot
        </Button>
        <Button variant="filled" size="small" onClick={addSpacer}>
          <PlusIcon className="size-3.5 text-gray-9" /> Add spacer
        </Button>
      </div>

      <PresetsPanel presets={slotPresets} localSlots={localSlots} handlers={presetHandlers} />
    </div>
  );
}
