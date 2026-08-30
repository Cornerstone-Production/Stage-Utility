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
import { viewSurface } from "@main/types/views";
import { MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { invoke, type ApiError } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { writeOptimistic } from "../lib/optimistic";
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
import { screensListViews } from "@main/services/home-view";

function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

/**
 * `ids` in the order given, then anything not named, in its existing order.
 *
 * The tail matters: a reorder sends the ids the drag knew about, and a row added
 * by somebody else between the fetch and the drop is not among them. Appending
 * rather than dropping means a concurrent add survives a reorder instead of
 * vanishing from the operator's list.
 */
function reorderById<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const named = ids.map((id) => byId.get(id)).filter((r): r is T => r != null);
  const seen = new Set(ids);
  return [...named, ...rows.filter((r) => !seen.has(r.id))];
}

/** One output patched, the rest untouched. */
function patchOutput(outputs: readonly Output[], id: string, patch: Partial<Output>): Output[] {
  return outputs.map((o) => (o.id === id ? { ...o, ...patch } : o));
}

/**
 * Which view a surface is editing.
 *
 * A pinned id -- the layout editor's URL parameter -- wins outright and is never
 * defaulted away, even when it does not resolve: a caller that names a view it
 * cannot find must render nothing rather than quietly edit a different one.
 * Without this the editor's slot half defaulted to the first view while its
 * alignment half used the URL's, so opening the second slots view showed the
 * first view's slots and Save wrote them onto the first.
 */
export function selectViewId(pinned: string | undefined, own: string): string {
  return pinned ?? own;
}

/**
 * @param pinnedViewId The view this surface is editing, when it knows.
 *
 * This hook is per-component -- there is no shared context -- so every caller
 * gets its OWN selectedViewId, and the resync below defaults it to the first
 * view. The layout editor route resolved its view from the URL but never said
 * so here, and the slot editor reads and WRITES through selectedViewId: opening
 * the second slots view showed the first view's slots under the second's name,
 * and Save wrote them onto the first. screens-route called setSelectedViewId on
 * its own instance before navigating, which reached nothing.
 *
 * Pinning it is the fix rather than an effect, because an effect leaves one
 * render where the slot state mirrors the wrong view.
 */
export function useStageSettings(pinnedViewId?: string) {
  const queryClient = useQueryClient();

  /**
   * Send a state-changing command and install the StageState it returns.
   *
   * Twenty-one handlers were this same eight-line body -- try, ipc, setQueryData,
   * catch, toast -- differing only in channel, payload and message. Twenty-one
   * chances for one of them to forget the cache write and leave the UI showing
   * the value the server just rejected.
   *
   * Three shapes, all preserved exactly:
   *  - `fail` set: the toast reads "<fail>: <err>", as every one of them did.
   *  - `fail` omitted: the server's own message, verbatim. Used where the refusal
   *    is written FOR the operator ("that would strand two screens") and a prefix
   *    would bury it.
   *  - `ok` set: a success toast as well, for the two writes that confirm.
   *
   * Returns whether it succeeded, so a caller that has follow-up work -- one
   * invalidates the plan list -- can do it only when the write actually landed.
   *
   * `writeTo` is the same over any query key: the layout-template and slot-preset
   * lists are eight more copies of this body against their own caches.
   */
  async function writeTo<T>(
    key: string[],
    channel: string,
    payload?: unknown,
    opts: { fail?: string; ok?: string } = {},
  ): Promise<T | null> {
    try {
      const next = await ipc<T>(channel, payload);
      queryClient.setQueryData(key, next);
      if (opts.ok) toast.success(opts.ok);
      return next;
    } catch (err) {
      toast.error(opts.fail ? `${opts.fail}: ${String(err)}` : errorMessage(err));
      return null;
    }
  }

  /** The StageState as it stands right now, from the cache every write updates.
   *  Read fresh at each step: these handlers make TWO writes and the second has
   *  to see what the first did. */
  const stateNow = () => queryClient.getQueryData<StageState>(["stage:getState"]);

  /** The same, for the writes that return a fresh StageState. */
  async function writeState(
    channel: string,
    payload?: unknown,
    opts: { fail?: string; ok?: string } = {},
  ): Promise<boolean> {
    return (await writeTo<StageState>(["stage:getState"], channel, payload, opts)) != null;
  }

  /** The shared optimistic write, with this hook's queryClient bound in. */
  const optimistic = <T,>(
    key: string[],
    project: (current: T) => T,
    send: () => Promise<T>,
    fail?: string,
  ) => writeOptimistic<T>(queryClient, key, project, send, fail);

  const { data: stageState, isLoading: stageLoading } = useStageStateQuery();
  const { data: serviceTypes = [] } = useServiceTypes(stageState);
  const { data: plans = [] } = usePlans(stageState);
  const { data: teamPositions = [] } = useTeamPositions(stageState);
  const { data: wirelessChannels = [] } = useWirelessChannels();
  const { data: layoutTemplates = [] } = useLayoutTemplates();
  const { data: slotPresets = [] } = useSlotPresets();
  const { data: updateStatus = null } = useUpdateStatus();

  // Selected View for the Views tab master-detail (default to the first view).
  const [ownSelectedViewId, setOwnSelectedViewId] = useState<string>("");
  // A pinned id wins outright and is never defaulted away. No fallback to the
  // first view when it does not resolve: a caller that names a view it cannot
  // find must render nothing rather than quietly edit a different one.
  const selectedViewId = selectViewId(pinnedViewId, ownSelectedViewId);
  const setSelectedViewId = setOwnSelectedViewId;

  useResyncOn([stageState, ownSelectedViewId, pinnedViewId], () => {
    if (pinnedViewId || !stageState) return;
    // Home excluded: this picks a DEFAULT selection, and Home is not selectable
    // anywhere — it is edited in its own tab.
    const views = screensListViews(stageState.views ?? []);
    if (views.length === 0) {
      if (ownSelectedViewId) setOwnSelectedViewId("");
      return;
    }
    if (!ownSelectedViewId || !views.find((v) => v.id === ownSelectedViewId)) {
      setOwnSelectedViewId(views[0].id);
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
    if (await writeState("stage:setServiceType", { id }, { fail: "Failed to set service type" })) {
      queryClient.invalidateQueries({ queryKey: ["stage:listPlans"] });
    }
  }

  async function handlePlanModeChange(mode: "auto" | "manual") {
    await writeState("stage:setPlanMode", { mode }, { fail: "Failed to set plan mode" });
  }

  async function handlePlanChange(id: string) {
    await writeState("stage:setPlan", { id }, { fail: "Failed to set plan" });
  }

  async function handleNextPlan() {
    await writeState("stage:selectNextPlan", undefined, { fail: "Failed to select next plan" });
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
    await writeState("stage:setShowQr", { show }, { fail: "Failed to update QR setting" });
  }

  async function handleDismissOnboarding() {
    await writeState("stage:setOnboardingDismissed", { dismissed: true }, { fail: "Failed to dismiss" });
  }

  async function handleSetPublicUrl(url: string | null) {
    await writeState("stage:setPublicUrl", { url }, {
      fail: "Failed to update public URL",
      ok: url ? "Public URL updated." : "Public URL cleared.",
    });
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
    await writeState("update:setAuto", partial, { fail: "Failed to update auto-update settings" });
  }

  async function handleSetReconnectSchedule(partial: { enabled?: boolean; leadMin?: number; tailMin?: number; dormantMin?: number }) {
    await writeState("settings:setReconnectSchedule", partial, { fail: "Failed to update reconnect settings" });
  }


  async function handleSetTaperWindow(partial: { preMin?: number; postMin?: number }) {
    await writeState("settings:setTaperWindow", partial, { fail: "Failed to update taper settings" });
  }

  /** Which plan notes feed the pre-service checklist. */
  async function handleSetChecklistSources(categories: string[], teams: string[]) {
    await writeState(
      "settings:setChecklistSources",
      { categories, teams },
      { fail: "Failed to save which notes feed the checklist" },
    );
  }

  async function handleSetTimezone(tz: string | null) {
    await writeState("settings:setTimezone", { timezone: tz }, { fail: "Failed to set the time zone" });
  }

  /** How the app displays a time of day. Global, like the time zone. */
  async function handleSetHourCycle(cycle: "12h" | "24h") {
    await writeState("settings:setHourCycle", { hourCycle: cycle }, { fail: "Failed to set the clock format" });
  }

  async function handleSetAllowedServiceTypes(ids: string[]) {
    await writeState("stage:setAllowedServiceTypes", { ids }, { fail: "Failed to update allowed service types" });
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
    await writeState("stage:setBranding", partial, {
      fail: "Failed to update branding",
      ok: "Branding updated.",
    });
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
  async function handleAddView(
    name: string,
    kind: ViewKind,
    surface: "display" | "console" = "display",
  ): Promise<string | null> {
    try {
      const next = await ipc<StageState>("views:add", { name, kind, surface });
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
    await writeState("views:rename", { id, name }, { fail: "Failed to rename view" });
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
    await writeState("views:remove", { id }, { fail: "Failed to remove view" });
  }

  async function handleSetViewKind(id: string, kind: ViewKind) {
    await writeState("views:setKind", { id, kind }, { fail: "Failed to change view type" });
  }

  async function handleSetViewSlotsLayout(id: string, slotsLayout: SlotsLayout | null) {
    await writeState("views:setSlotsLayout", { id, slotsLayout }, { fail: "Failed to update alignment" });
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
    await writeTo<LayoutTemplate[]>(["layoutTemplates:list"], "layoutTemplates:save", { name, layout }, {
      fail: "Failed to save layout",
      ok: `Saved layout "${name}".`,
    });
  }

  async function handleUpdateLayoutTemplate(id: string, patch: { name?: string; layout?: LayoutDTO }) {
    await writeTo<LayoutTemplate[]>(["layoutTemplates:list"], "layoutTemplates:update", { id, ...patch }, {
      fail: "Failed to update layout",
      ok: "Layout updated.",
    });
  }

  async function handleDeleteLayoutTemplate(id: string) {
    await writeTo<LayoutTemplate[]>(["layoutTemplates:list"], "layoutTemplates:delete", { id }, {
      fail: "Failed to delete layout",
    });
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
    await writeTo<SlotPreset[]>(["presets:list"], "presets:delete", { id }, {
      fail: "Failed to delete arrangement",
    });
  }

  async function handleImportPreset(name: string, slots: Slot[]) {
    await writeTo<SlotPreset[]>(["presets:list"], "presets:import", { name, slots }, {
      fail: "Failed to import arrangement",
      ok: `Imported arrangement "${name}".`,
    });
  }

  async function handleReorderPresets(ids: string[]) {
    await optimistic<SlotPreset[]>(
      ["presets:list"],
      (cur) => reorderById(cur, ids),
      () => ipc<SlotPreset[]>("presets:reorder", { ids }),
      "Failed to reorder arrangements",
    );
  }

  async function handleRenamePreset(id: string, name: string) {
    await writeTo<SlotPreset[]>(["presets:list"], "presets:rename", { id, name }, {
      fail: "Failed to rename arrangement",
    });
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
    await writeState("outputs:add", {}, { fail: "Failed to add display" });
  }

  async function handleRenameOutput(id: string, name: string) {
    await writeState("outputs:rename", { id, name }, { fail: "Failed to rename display" });
  }

  async function handleSetOutputView(id: string, viewId: string | null) {
    // Optimistically update so the controlled <Select> reflects the new view
    // immediately instead of snapping back to the stale cached value while the
    // request is in flight; reconcile (or roll back) once the server responds.
    await optimistic<StageState>(
      ["stage:getState"],
      (cur) => ({ ...cur, outputs: patchOutput(cur.outputs, id, { viewId }) }),
      () => ipc<StageState>("outputs:setView", { id, viewId }),
      "Failed to route display",
    );
  }

  async function handleSetOutputLocked(id: string, locked: boolean) {
    await optimistic<StageState>(
      ["stage:getState"],
      (cur) => ({ ...cur, outputs: patchOutput(cur.outputs, id, { locked }) }),
      () => ipc<StageState>("outputs:setLocked", { id, locked }),
      "Failed to update display lock",
    );
  }

  /** Show or hide one display's kiosk top bar. Optimistic like the lock: the
   *  server only refuses an id that does not exist, and the menu label has to
   *  flip under the operator's finger. */
  async function handleSetOutputHideTopBar(id: string, hideTopBar: boolean) {
    await optimistic<StageState>(
      ["stage:getState"],
      (cur) => ({ ...cur, outputs: patchOutput(cur.outputs, id, { hideTopBar }) }),
      () => ipc<StageState>("outputs:setHideTopBar", { id, hideTopBar }),
      "Failed to update the display's top bar",
    );
  }

  /**
   * Make a screen a read-only display or an interactive control surface.
   *
   * NOT optimistic. The server refuses some of these — demoting a panel that is
   * showing a console, for one — and an optimistic flip would show the operator
   * the change happening and then silently undo it. The refusal is the useful
   * part; it says what to do instead.
   */
  /**
   * A screen's mode and its view's surface move together, and the ORDER is not
   * a detail.
   *
   * Two guards on the server refuse in opposite directions, each waiting for the
   * other side to move first:
   *
   *   setOutputMode(display)   refuses while the view it shows is a console
   *   setViewSurface(console)  refuses while a screen showing it is not a panel
   *
   * So there is one rule: whichever side is being made MORE permissive goes
   * first. Becoming a control surface, the screen leads; becoming a wall screen,
   * the view does. Doing it the other way round is a deadlock — "Use as a
   * display" was refused outright, with the server correctly explaining that the
   * screen was still showing a control surface, and no order of clicking could
   * get out of it.
   */
  async function handleSetOutputMode(id: string, mode: "display" | "panel") {
    const shown = stateNow()?.outputs.find((o) => o.id === id)?.viewId ?? null;
    const wantSurface = mode === "panel" ? "console" : "display";
    const viewNeedsIt = (() => {
      const v = stateNow()?.views.find((x) => x.id === shown);
      return v ? viewSurface(v) !== wantSurface : false;
    })();

    if (mode === "display" && shown && viewNeedsIt) {
      // The view first: the screen cannot become a display while it is on one.
      if (!(await writeState("views:setSurface", { id: shown, surface: "display" }))) return;
      await writeState("outputs:setMode", { id, mode });
      return;
    }

    if (!(await writeState("outputs:setMode", { id, mode }))) return;
    if (shown && viewNeedsIt) {
      await writeState("views:setSurface", { id: shown, surface: wantSurface });
    }
  }

  /** Change what a View is for, and the screens showing it, in the order the
   *  guards allow. See handleSetOutputMode. */
  async function handleSetViewSurface(id: string, surface: "display" | "console") {
    const wantMode = surface === "console" ? "panel" : "display";
    const showing = (stateNow()?.outputs ?? []).filter(
      (o) => o.viewId === id && (o.mode ?? "display") !== wantMode,
    );

    if (surface === "console") {
      // The screens first: the view cannot become a console while a screen
      // showing it is still a plain display.
      for (const o of showing) {
        if (!(await writeState("outputs:setMode", { id: o.id, mode: "panel" }))) return;
      }
      await writeState("views:setSurface", { id, surface });
      return;
    }

    if (!(await writeState("views:setSurface", { id, surface }))) return;
    for (const o of showing) {
      await writeState("outputs:setMode", { id: o.id, mode: "display" });
    }
  }

  async function handleRemoveOutput(id: string) {
    await writeState("outputs:remove", { id }, { fail: "Failed to remove display" });
  }

  async function handleReorderOutputs(ids: string[]) {
    await optimistic<StageState>(
      ["stage:getState"],
      (cur) => ({ ...cur, outputs: reorderById(cur.outputs, ids) }),
      () => ipc<StageState>("outputs:reorder", { ids }),
      "Failed to reorder displays",
    );
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
    handleSetChecklistSources,
    handleSetTimezone,
    handleSetHourCycle,
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
    handleSetOutputHideTopBar,
    handleSetOutputMode,
    handleSetViewSurface,
    handleRemoveOutput,
    handleReorderOutputs,
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
