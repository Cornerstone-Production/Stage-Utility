// Every write the settings surfaces make, and the local editor state they need.
//
// Lifted out of settings-view.tsx UNCHANGED - the handler bodies here were moved
// mechanically, not retyped, so a surface that misbehaves after the move is a
// routing problem rather than a rewritten handler. The returned object is the
// same `SectionHandlers` the sections already take, so no section's props
// changed either.
//
// It carries the slot-editor state (localSlots, slotsDirty, ...) because the
// contract does: SectionHandlers includes updateSlot/addSlot/saveSlots and the
// dnd sensors, which cannot exist without it. That state is local to the Views
// surface, and only that route calls this for its slot half.
//
// What deliberately did NOT come along:
//   - the four SSE subscriptions and applyAccentVar, which must outlive any one
//     route and now live in live-wiring.ts, mounted once by the Shell
//   - the update-restart handshake, now module-scoped in update-lifecycle.ts
//     so it survives navigating away mid-update
//   - navigateToSection, which becomes routing plus flash.ts
//   - useEscapeToClose, which called window:closeSettings - meaningless once
//     Settings is routes inside the app rather than its own window

import { useState, useEffect } from "react";
import { MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { invoke, type ApiError } from "../lib/api";
import { toast, confirm } from "../components/ui";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import type { SectionHandlers } from "../settings/types";
import {
  useStageStateQuery,
  useServiceTypes,
  usePlans,
  useTeamPositions,
  useWirelessChannels,
  useLayoutTemplates,
  useSlotPresets,
  useUpdateStatus,
} from "./queries";
import { markUpdatePending } from "./update-lifecycle";

/** Matches settings-view.tsx's local helper, so the moved bodies are identical. */
function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

export function useStageSettings() {
  const queryClient = useQueryClient();

  const { data: stageState, isLoading: stageLoading } = useStageStateQuery();
  const { data: serviceTypes = [] } = useServiceTypes(stageState);
  const { data: plans = [] } = usePlans(stageState);
  const { data: teamPositions = [] } = useTeamPositions(stageState);
  const { data: wirelessChannels = [] } = useWirelessChannels();
  const { data: layoutTemplates = [] } = useLayoutTemplates();
  const { data: slotPresets = [] } = useSlotPresets();
  const { data: updateStatus = null } = useUpdateStatus();

  // Selected View for the Views tab master-detail (default to the first view).
  const [selectedViewId, setSelectedViewId] = useState<string>("");

  useResyncOn([stageState, selectedViewId], () => {
    if (!stageState) return;
    const views = stageState.views ?? [];
    if (views.length === 0) {
      if (selectedViewId) setSelectedViewId("");
      return;
    }
    if (!selectedViewId || !views.find((v) => v.id === selectedViewId)) {
      setSelectedViewId(views[0].id);
    }
  });

  // Local slot editor state
  const [localSlots, setLocalSlots] = useState<Slot[]>([]);
  const [slotsDirty, setSlotsDirty] = useState(false);
  const [isSavingSlots, setIsSavingSlots] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Mirror the selected View's resolved slots into the editor (unless dirty).
  useResyncOn([stageState, selectedViewId, slotsDirty], () => {
    if (!stageState || slotsDirty) return;
    const viewSlots = stageState.slotsByView?.[selectedViewId] ?? [];
    setLocalSlots([...viewSlots].sort((a, b) => a.order - b.order));
  });

  // Live draft preview: while slots are dirty, resolve the in-progress edits
  // server-side (no save) so the preview iframe can show the draft exactly as the
  // kiosk would. Debounced to avoid a request per keystroke; cleared when clean.
  const [resolvedDraftSlots, setResolvedDraftSlots] = useState<Slot[] | null>(null);
  useResyncOn([slotsDirty], () => {
    if (!slotsDirty) setResolvedDraftSlots(null);
  });

  useEffect(() => {
    if (!slotsDirty) return;
    let cancelled = false;
    const t = setTimeout(() => {
      ipc<Slot[]>("views:resolveSlots", { slots: localSlots.map((s, i) => ({ ...s, order: i })) })
        .then((resolved) => {
          if (!cancelled) setResolvedDraftSlots(resolved);
        })
        .catch((err) => console.error("[settings:resolveDraftSlots]", err));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [slotsDirty, localSlots]);
  // DnD sensors — mouse and touch deliberately separate.
  //
  // A single PointerSensor treats them identically: it claims the gesture on
  // touch-down and waits to see whether you move far enough to be dragging,
  // which is exactly the window in which the page cannot scroll. On a phone
  // that made the Displays and Views lists unscrollable, because every swipe
  // that began on a card started as a maybe-drag.
  //
  // Distance works for a mouse, where a click is a distinct act from a drag.
  // Touch needs TIME instead: hold briefly to drag, swipe to scroll. 200ms is
  // short enough to feel deliberate and long enough that a flick never trips it.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setLocalSlots((prev) => {
      // Reorder by stacked GROUP (lead + `stackWithPrevious` followers) keyed by
      // the lead slot's id, so a stacked column moves as one and never splits.
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

  async function handleDismissOnboarding() {
    try {
      const next = await ipc<StageState>("stage:setOnboardingDismissed", { dismissed: true });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to dismiss: ${String(err)}`);
    }
  }

  async function handleSetPublicUrl(url: string | null) {
    try {
      const next = await ipc<StageState>("stage:setPublicUrl", { url });
      queryClient.setQueryData(["stage:getState"], next);
      toast.success(url ? "Public URL updated." : "Public URL cleared.");
    } catch (err) {
      toast.error(`Failed to update public URL: ${String(err)}`);
    }
  }

  async function handleCheckUpdates() {
    try {
      const status = await ipc<UpdateStatus>("update:check");
      queryClient.setQueryData(["update:status"], status);
      // canUpdate, NOT isGitRepo: a Homebrew or tarball install is not a git
      // checkout and checks fine. Keying this toast off isGitRepo told every
      // packaged install "update from the command line" over a check that had
      // just succeeded — the same bug the backend gate had, one layer up.
      if (status.canUpdate === false) {
        toast.error(status.updateBlockedReason ?? "In-app updates are not available for this install.");
      } else if (status.error) toast.error(`Update check failed: ${status.error}`);
      else if (status.behind > 0) toast.success(`${status.behind} update${status.behind === 1 ? "" : "s"} available.`);
      else toast.success("You're up to date.");
    } catch (err) {
      toast.error(`Update check failed: ${String(err)}`);
    }
  }

  async function handleApplyUpdate(override = false) {
    try {
      const status = await ipc<UpdateStatus>("update:apply", { override });
      queryClient.setQueryData(["update:status"], status);
      // Remember the version we're updating FROM, so the server:hello after the
      // restart (carrying a new version) tells us the apply finished — then we
      // reload this page to pick up the new assets and show a success banner.
      markUpdatePending();
      toast.success("Updating… this page will reload automatically when it's done.");
    } catch (err) {
      toast.error(`Failed to start update: ${String(err)}`);
    }
  }

  async function handleSetAutoUpdate(partial: { mode?: "manual" | "auto-install" | "auto-full"; enabled?: boolean; dayOfWeek?: number | null; hour?: number }) {
    try {
      const next = await ipc<StageState>("update:setAuto", partial);
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update auto-update settings: ${String(err)}`);
    }
  }

  async function handleSetReconnectSchedule(partial: { enabled?: boolean; leadMin?: number; tailMin?: number; dormantMin?: number }) {
    try {
      const next = await ipc<StageState>("settings:setReconnectSchedule", partial);
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update reconnect settings: ${String(err)}`);
    }
  }


  async function handleSetTaperWindow(partial: { preMin?: number; postMin?: number }) {
    try {
      const next = await ipc<StageState>("settings:setTaperWindow", partial);
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update taper settings: ${String(err)}`);
    }
  }

  async function handleSetTimezone(tz: string | null) {
    try {
      const next = await ipc<StageState>("settings:setTimezone", { timezone: tz });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to set the time zone: ${String(err)}`);
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

  async function handleSetBranding(partial: {
    name?: string;
    accentColor?: string | null;
    logo?: string | null;
    monochrome?: boolean;
    logoOriginal?: string | null;
    logoCrop?: { scale: number; x: number; y: number } | null;
    emptyLogo?: string | null;
    emptyLogoOriginal?: string | null;
    emptyLogoCrop?: { scale: number; x: number; y: number } | null;
    avatar?: string | null;
    avatarOriginal?: string | null;
    avatarCrop?: { scale: number; x: number; y: number } | null;
  }) {
    try {
      const next = await ipc<StageState>("stage:setBranding", partial);
      queryClient.setQueryData(["stage:getState"], next);
      toast.success("Branding updated.");
    } catch (err) {
      toast.error(`Failed to update branding: ${String(err)}`);
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
    // Next channel = highest existing numeric channel + 1, so deleting/reordering
    // slots doesn't produce duplicate or skipped channel numbers.
    const maxChannel = localSlots.reduce((max, s) => {
      const n = Number.parseInt(s.channel, 10);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    const newSlot: Slot = {
      id: `slot-${Date.now()}`,
      channel: String(maxChannel + 1).padStart(2, "0"),
      order: localSlots.length,
      link: { kind: "pco", matchBy: "position", positions: [] },
      deviceBinding: null,
      displayName: null,
      photoUrl: null,
      device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
    };
    setLocalSlots((prev) => [...prev, newSlot]);
    setSlotsDirty(true);
  }

  function addSpacer() {
    const newSlot: Slot = {
      id: `slot-${Date.now()}`,
      channel: "",
      order: localSlots.length,
      link: { kind: "spacer" },
      widthIn: 2,
      deviceBinding: null,
      displayName: null,
      photoUrl: null,
      device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
    };
    setLocalSlots((prev) => [...prev, newSlot]);
    setSlotsDirty(true);
  }

  function removeSlot(idx: number) {
    setLocalSlots((prev) => {
      const next = prev.map((s) => ({ ...s }));
      // If the next slot was stacked onto the one being deleted, break the stack
      // instead of letting it silently re-attach to the slot above the deleted one.
      if (next[idx + 1]?.stackWithPrevious) {
        next[idx + 1] = { ...next[idx + 1], stackWithPrevious: false };
      }
      return next.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i }));
    });
    setSlotsDirty(true);
  }

  async function saveSlots() {
    setIsSavingSlots(true);
    try {
      const slots = localSlots.map((s, i) => ({ ...s, order: i }));
      const next = await ipc<StageState>("views:setSlots", { id: selectedViewId, slots });
      queryClient.setQueryData(["stage:getState"], next);
      setSlotsDirty(false);
      toast.success("Slots saved.");
    } catch (err) {
      toast.error(`Failed to save slots: ${String(err)}`);
    } finally {
      setIsSavingSlots(false);
    }
  }

  // Drop unsaved slot edits: clearing dirty lets the mirror effect re-seed
  // localSlots from the saved server state, and the preview clears its draft.
  function discardSlots() {
    setSlotsDirty(false);
  }

  // ── Views (content) ──────────────────────────────────────────────────
  async function handleAddView(name: string, kind: ViewKind): Promise<string | null> {
    try {
      const next = await ipc<StageState>("views:add", { name, kind });
      queryClient.setQueryData(["stage:getState"], next);
      // Select the newly-created view (last in the list).
      const created = next.views?.[next.views.length - 1];
      if (created) setSelectedViewId(created.id);
      return created?.id ?? null;
    } catch (err) {
      toast.error(`Failed to add view: ${String(err)}`);
      return null;
    }
  }

  async function handleRenameView(id: string, name: string) {
    try {
      const next = await ipc<StageState>("views:rename", { id, name });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to rename view: ${String(err)}`);
    }
  }

  async function handleDuplicateView(id: string) {
    try {
      const next = await ipc<StageState>("views:duplicate", { id });
      queryClient.setQueryData(["stage:getState"], next);
      const created = next.views?.[next.views.length - 1];
      if (created) setSelectedViewId(created.id);
      toast.success("View duplicated.");
    } catch (err) {
      toast.error(`Failed to duplicate view: ${String(err)}`);
    }
  }

  async function handleRemoveView(id: string) {
    try {
      const next = await ipc<StageState>("views:remove", { id });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to remove view: ${String(err)}`);
    }
  }

  async function handleSetViewKind(id: string, kind: ViewKind) {
    try {
      const next = await ipc<StageState>("views:setKind", { id, kind });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to change view type: ${String(err)}`);
    }
  }

  async function handleSetViewSlotsLayout(id: string, slotsLayout: SlotsLayout | null) {
    try {
      const next = await ipc<StageState>("views:setSlotsLayout", { id, slotsLayout });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update alignment: ${String(err)}`);
    }
  }

  async function handleReorderViews(ids: string[]) {
    // Optimistic: reorder the cached state immediately so the drag feels instant.
    const prev = queryClient.getQueryData<StageState>(["stage:getState"]);
    if (prev) {
      const byId = new Map(prev.views.map((v) => [v.id, v]));
      const reordered = ids.map((id) => byId.get(id)).filter(Boolean) as View[];
      for (const v of prev.views) if (!ids.includes(v.id)) reordered.push(v);
      queryClient.setQueryData(["stage:getState"], { ...prev, views: reordered });
    }
    try {
      const next = await ipc<StageState>("views:reorder", { ids });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      if (prev) queryClient.setQueryData(["stage:getState"], prev);
      toast.error(`Failed to reorder views: ${String(err)}`);
    }
  }

  const revOf = (s: StageState | undefined, id: string) =>
    s?.views?.find((v) => v.id === id)?.layoutRev ?? 0;

  async function handleSetViewLayout(
    id: string,
    layout: LayoutDTO,
    layoutRev?: number,
  ): Promise<{ rev: number; discarded: boolean }> {
    try {
      const next = await ipc<StageState>("views:setLayout", { id, layout, layoutRev });
      queryClient.setQueryData(["stage:getState"], next);
      return { rev: revOf(next, id), discarded: false };
    } catch (err) {
      // 409: someone else saved this view since this editor opened it. Neither
      // outcome is safe to pick automatically — one loses their work, the other
      // loses yours — so the person who can see both decides.
      if ((err as ApiError).code === "layout-conflict") {
        const overwrite = await confirm({
          title: "Someone else changed this view",
          message: `${(err as Error).message} Overwrite their version with yours, or discard your changes and load theirs?`,
          confirmLabel: "Overwrite theirs",
          cancelLabel: "Keep theirs",
          destructive: true,
        });
        if (overwrite) {
          // No layoutRev = save unconditionally. Deliberate, and only reachable
          // from the dialog above.
          const next = await ipc<StageState>("views:setLayout", { id, layout });
          queryClient.setQueryData(["stage:getState"], next);
          toast.success("Layout saved, replacing the other version.");
          return { rev: revOf(next, id), discarded: false };
        }
        await queryClient.invalidateQueries({ queryKey: ["stage:getState"] });
        toast.success("Loaded their version. Your changes were discarded.");
        // Not an error to the caller — a chosen outcome. `discarded` tells the
        // editor to restart on the layout it just pulled.
        return { rev: revOf(queryClient.getQueryData<StageState>(["stage:getState"]), id), discarded: true };
      }
      toast.error(`Failed to save layout: ${String(err)}`);
      throw err;
    }
  }

  async function handleSaveLayoutTemplate(name: string, layout: LayoutDTO) {
    try {
      const list = await ipc<LayoutTemplate[]>("layoutTemplates:save", { name, layout });
      queryClient.setQueryData(["layoutTemplates:list"], list);
      toast.success(`Saved layout "${name}".`);
    } catch (err) {
      toast.error(`Failed to save layout: ${String(err)}`);
    }
  }

  async function handleUpdateLayoutTemplate(id: string, patch: { name?: string; layout?: LayoutDTO }) {
    try {
      const list = await ipc<LayoutTemplate[]>("layoutTemplates:update", { id, ...patch });
      queryClient.setQueryData(["layoutTemplates:list"], list);
      toast.success("Layout updated.");
    } catch (err) {
      toast.error(`Failed to update layout: ${String(err)}`);
    }
  }

  async function handleDeleteLayoutTemplate(id: string) {
    try {
      const list = await ipc<LayoutTemplate[]>("layoutTemplates:delete", { id });
      queryClient.setQueryData(["layoutTemplates:list"], list);
    } catch (err) {
      toast.error(`Failed to delete layout: ${String(err)}`);
    }
  }

  async function handleCopySlots(targetViewId: string, fromViewId: string) {
    try {
      const next = await ipc<StageState>("views:copySlots", { id: targetViewId, fromViewId });
      queryClient.setQueryData(["stage:getState"], next);
      const viewSlots = next.slotsByView?.[targetViewId] ?? [];
      setLocalSlots([...viewSlots].sort((a, b) => a.order - b.order));
      setSlotsDirty(false);
      toast.success("Slots copied.");
    } catch (err) {
      toast.error(`Failed to copy slots: ${String(err)}`);
    }
  }

  // ── Presets (saved slot arrangements) ────────────────────────────────
  async function handleSavePreset(name: string) {
    try {
      // Persist any pending editor edits first so the preset captures what's on screen.
      if (slotsDirty) await saveSlots();
      const presets = await ipc<SlotPreset[]>("presets:save", { name, viewId: selectedViewId });
      queryClient.setQueryData(["presets:list"], presets);
      toast.success(`Saved arrangement "${name}".`);
    } catch (err) {
      toast.error(`Failed to save arrangement: ${String(err)}`);
    }
  }

  async function handleApplyPreset(id: string) {
    try {
      const next = await ipc<StageState & { appliedViewId?: string }>("presets:apply", {
        id,
        viewId: selectedViewId,
      });
      queryClient.setQueryData(["stage:getState"], next);
      // Read back the view the SERVER says it wrote, not the one we asked for.
      // Those differed when an output shared an id with a view, and reading the
      // requested id showed the unchanged slots — a silent no-op under a success
      // toast. If they still differ, that is a bug worth surfacing, not hiding.
      const appliedTo = next.appliedViewId ?? selectedViewId;
      if (appliedTo !== selectedViewId) {
        toast.error(`Arrangement went to "${appliedTo}", not the view you are editing. Nothing was changed here.`);
        return;
      }
      const viewSlots = next.slotsByView?.[appliedTo] ?? [];
      setLocalSlots([...viewSlots].sort((a, b) => a.order - b.order));
      setSlotsDirty(false);
      toast.success("Arrangement applied.");
    } catch (err) {
      toast.error(`Failed to apply arrangement: ${String(err)}`);
    }
  }

  async function handleDeletePreset(id: string) {
    try {
      const presets = await ipc<SlotPreset[]>("presets:delete", { id });
      queryClient.setQueryData(["presets:list"], presets);
    } catch (err) {
      toast.error(`Failed to delete arrangement: ${String(err)}`);
    }
  }

  async function handleImportPreset(name: string, slots: Slot[]) {
    try {
      const presets = await ipc<SlotPreset[]>("presets:import", { name, slots });
      queryClient.setQueryData(["presets:list"], presets);
      toast.success(`Imported arrangement "${name}".`);
    } catch (err) {
      toast.error(`Failed to import arrangement: ${String(err)}`);
    }
  }

  async function handleReorderPresets(ids: string[]) {
    // Optimistic: reorder the cached list immediately so the drag feels instant.
    const prev = queryClient.getQueryData<SlotPreset[]>(["presets:list"]);
    if (prev) {
      const byId = new Map(prev.map((p) => [p.id, p]));
      const reordered = ids.map((id) => byId.get(id)).filter(Boolean) as SlotPreset[];
      for (const p of prev) if (!ids.includes(p.id)) reordered.push(p);
      queryClient.setQueryData(["presets:list"], reordered);
    }
    try {
      const presets = await ipc<SlotPreset[]>("presets:reorder", { ids });
      queryClient.setQueryData(["presets:list"], presets);
    } catch (err) {
      if (prev) queryClient.setQueryData(["presets:list"], prev);
      toast.error(`Failed to reorder arrangements: ${String(err)}`);
    }
  }

  async function handleRenamePreset(id: string, name: string) {
    try {
      const presets = await ipc<SlotPreset[]>("presets:rename", { id, name });
      queryClient.setQueryData(["presets:list"], presets);
    } catch (err) {
      toast.error(`Failed to rename arrangement: ${String(err)}`);
    }
  }

  async function handleOverwritePreset(id: string) {
    try {
      // Persist any pending editor edits first so the preset captures what's on screen.
      if (slotsDirty) await saveSlots();
      const presets = await ipc<SlotPreset[]>("presets:overwrite", { id, displayId: selectedViewId });
      queryClient.setQueryData(["presets:list"], presets);
      toast.success("Arrangement overwritten with current slots.");
    } catch (err) {
      toast.error(`Failed to overwrite arrangement: ${String(err)}`);
    }
  }

  // ── Outputs (physical screens + routing) ─────────────────────────────
  async function handleAddOutput() {
    try {
      const next = await ipc<StageState>("outputs:add", {});
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to add display: ${String(err)}`);
    }
  }

  async function handleRenameOutput(id: string, name: string) {
    try {
      const next = await ipc<StageState>("outputs:rename", { id, name });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to rename display: ${String(err)}`);
    }
  }

  async function handleSetOutputView(id: string, viewId: string | null) {
    // Optimistically update so the controlled <Select> reflects the new view
    // immediately instead of snapping back to the stale cached value while the
    // request is in flight; reconcile (or roll back) once the server responds.
    const prev = queryClient.getQueryData<StageState>(["stage:getState"]);
    if (prev) {
      const outputs = prev.outputs.map((o) => (o.id === id ? { ...o, viewId } : o));
      queryClient.setQueryData(["stage:getState"], { ...prev, outputs });
    }
    try {
      const next = await ipc<StageState>("outputs:setView", { id, viewId });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      if (prev) queryClient.setQueryData(["stage:getState"], prev);
      toast.error(`Failed to route display: ${String(err)}`);
    }
  }

  async function handleSetOutputLocked(id: string, locked: boolean) {
    const prev = queryClient.getQueryData<StageState>(["stage:getState"]);
    if (prev) {
      const outputs = prev.outputs.map((o) => (o.id === id ? { ...o, locked } : o));
      queryClient.setQueryData(["stage:getState"], { ...prev, outputs });
    }
    try {
      const next = await ipc<StageState>("outputs:setLocked", { id, locked });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      if (prev) queryClient.setQueryData(["stage:getState"], prev);
      toast.error(`Failed to update display lock: ${String(err)}`);
    }
  }

  async function handleRemoveOutput(id: string) {
    try {
      const next = await ipc<StageState>("outputs:remove", { id });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to remove display: ${String(err)}`);
    }
  }

  async function handleReorderOutputs(ids: string[]) {
    const prev = queryClient.getQueryData<StageState>(["stage:getState"]);
    if (prev) {
      const byId = new Map(prev.outputs.map((o) => [o.id, o]));
      const reordered = ids.map((id) => byId.get(id)).filter(Boolean) as Output[];
      for (const o of prev.outputs) if (!ids.includes(o.id)) reordered.push(o);
      queryClient.setQueryData(["stage:getState"], { ...prev, outputs: reordered });
    }
    try {
      const next = await ipc<StageState>("outputs:reorder", { ids });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      if (prev) queryClient.setQueryData(["stage:getState"], prev);
      toast.error(`Failed to reorder displays: ${String(err)}`);
    }
  }

  async function handleOpenOutputWindow(id: string) {
    const url = `${window.location.origin}/${encodeURIComponent(id)}`;
    window.open(url, `display-${id}`);
  }

  async function handleRefreshDisplay(id: string | null) {
    try {
      await ipc("displays:refresh", { id: id ?? "" });
      toast.success(id ? "Refresh sent to display." : "Refresh sent to all displays.");
    } catch (err) {
      toast.error(`Failed to refresh display: ${String(err)}`);
    }
  }

  const handlers: SectionHandlers = {
    handleServiceTypeChange,
    handlePlanModeChange,
    handlePlanChange,
    handleNextPlan,
    handleRefresh,
    handleShowQrChange,
    handleSetPublicUrl,
    handleCheckUpdates,
    handleApplyUpdate,
    handleSetAutoUpdate,
    handleSetReconnectSchedule,
    handleSetTaperWindow,
    handleSetTimezone,
    handleSetAllowedServiceTypes,
    handleSetBranding,
    updateSlot,
    addSlot,
    addSpacer,
    removeSlot,
    saveSlots,
    discardSlots,
    handleSetViewSlotsLayout,
    handleAddView,
    handleRenameView,
    handleDuplicateView,
    handleRemoveView,
    handleSetViewKind,
    handleSetViewLayout,
    handleSaveLayoutTemplate,
    handleUpdateLayoutTemplate,
    handleDeleteLayoutTemplate,
    handleCopySlots,
    handleReorderViews,
    handleSavePreset,
    handleApplyPreset,
    handleDeletePreset,
    handleImportPreset,
    handleReorderPresets,
    handleRenamePreset,
    handleOverwritePreset,
    handleAddOutput,
    handleRenameOutput,
    handleSetOutputView,
    handleSetOutputLocked,
    handleRemoveOutput,
    handleReorderOutputs,
    handleOpenOutputWindow,
    handleRefreshDisplay,
    handleDragEnd,
    sensors,
  };

  return {
    stageState,
    stageLoading,
    serviceTypes,
    plans,
    teamPositions,
    wirelessChannels,
    layoutTemplates,
    slotPresets,
    updateStatus,
    selectedViewId,
    setSelectedViewId,
    localSlots,
    slotsDirty,
    isSavingSlots,
    isRefreshing,
    resolvedDraftSlots,
    handleDismissOnboarding,
    handlers,
  };
}
