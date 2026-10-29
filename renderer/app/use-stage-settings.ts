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

import { useState } from "react";
import { screenName, type CreateScreenInput, type ViewSurface } from "@main/types/views";
import type { Rotation } from "@main/types/output-format";
import type { AppIconInput } from "@main/services/app-icon";
import { MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { invoke as ipc, type ApiError, type IpcChannel } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { writeOptimistic } from "../lib/optimistic";
import { toast, confirm } from "../components/ui";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { changeViewRole } from "../settings/view-role-change";
import type { CreateScreenOutcome, RemoveViewOutcome, SectionHandlers } from "../settings/types";
import {
  useStageStateQuery,
  useServiceTypes,
  usePlans,
  useWirelessChannels,
  useLayoutTemplates,
  useSlotPresets,
  useUpdateStatus,
  QUERY_KEYS,
} from "./queries";
import { markUpdatePending } from "./update-lifecycle";
import { screensListViews } from "@main/services/home-view";
import { plural } from "@main/services/plural";

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
    channel: IpcChannel,
    payload?: Record<string, unknown>,
    opts: { fail?: string; ok?: string } = {},
  ): Promise<T | null> {
    try {
      const next = await ipc<T>(channel, payload);
      queryClient.setQueryData(key, next);
      if (opts.ok) toast.success(opts.ok);
      return next;
    } catch (err) {
      toast.error(opts.fail ? `${opts.fail}: ${errorMessage(err)}` : errorMessage(err));
      return null;
    }
  }

  /** The StageState as it stands right now, from the cache every write updates.
   *
   *  A FUNCTION rather than a value destructured in the hook body, because a
   *  value would be the state as of the render that made the closure — stale by
   *  the time a click arrives, which is how a handler comes to pick the wrong
   *  side to move first.
   *
   *  It is a read at the moment of the click, not a promise about what the
   *  server holds when the write lands. handleSetViewSurface sends the screens it
   *  asked about with its write, so the server can refuse when they are stale. */
  const stateNow = () => queryClient.getQueryData<StageState>(["stage:getState"]);

  /** The same, for the writes that return a fresh StageState. */
  async function writeState(
    channel: IpcChannel,
    payload?: Record<string, unknown>,
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

  const [isRefreshing, setIsRefreshing] = useState(false);

  // DnD sensors for the Screens page's card reorder -- mouse and touch
  // deliberately separate.
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
      toast.error(`Refresh failed: ${errorMessage(err)}`);
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
      else if (status.behind > 0) toast.success(`${plural(status.behind, "update")} available.`);
      else toast.success("You're up to date.");
    } catch (err) {
      toast.error(`Update check failed: ${errorMessage(err)}`);
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
      toast.error(`Failed to start update: ${errorMessage(err)}`);
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

  /** How the slot editors' plan switcher steps. Editor-only — it changes nothing
   *  the screens follow. */
  async function handleSetPlanSwitcherMode(mode: PlanSwitcherMode) {
    await writeState("stage:setPlanSwitcherMode", { mode }, { fail: "Failed to change how the plan switcher steps" });
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
    icon?: AppIconInput | null;
  }): Promise<boolean> {
    // The write's result goes back to the caller: a dialog that closes on success
    // must not close on a refusal, and the toast alone says nothing to the dialog.
    return writeState("stage:setBranding", partial, {
      fail: "Failed to update branding",
      ok: "Branding updated.",
    });
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
      toast.error(`Failed to add view: ${errorMessage(err)}`);
      return null;
    }
  }

  async function handleRenameView(id: string, name: string) {
    await writeState("views:rename", { id, name }, { fail: "Failed to rename view" });
  }

  /** Resolves the copy's id, or null when it could not be made (already toasted). */
  async function handleDuplicateView(id: string): Promise<string | null> {
    try {
      // The answer is the state and the id of the copy this call made.
      const { viewId, ...next } = await ipc<StageState & { viewId?: string }>("views:duplicate", { id });
      queryClient.setQueryData(["stage:getState"], next);
      if (viewId) setSelectedViewId(viewId);
      toast.success("View duplicated.");
      return viewId ?? null;
    } catch (err) {
      toast.error(`Failed to duplicate view: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Resolves whether the view is gone. A failure is toasted here; the answer is for
   *  a caller that does more after it (removing a screen AND its view). With
   *  `ifUnshown`, a screen showing the view is not a failure: the server refuses and
   *  the screens come back in `shownOn` for the caller to say. */
  async function handleRemoveView(id: string, opts: { ifUnshown?: boolean } = {}): Promise<RemoveViewOutcome> {
    try {
      const next = await ipc<StageState>("views:remove", { id, ...(opts.ifUnshown ? { ifUnshown: true } : {}) });
      queryClient.setQueryData(["stage:getState"], next);
      return { removed: true };
    } catch (err) {
      const e = err as ApiError;
      const screens = e.code === "view-shown" && Array.isArray(e.body?.screens) ? (e.body.screens as { id: string; name?: string }[]) : null;
      if (screens) return { removed: false, shownOn: screens.map(screenName) };
      toast.error(`Failed to remove view: ${errorMessage(err)}`);
      return { removed: false };
    }
  }

  async function handleSetViewKind(id: string, kind: ViewKind) {
    await writeState("views:setKind", { id, kind }, { fail: "Failed to change view type" });
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
      toast.error(`Failed to save layout: ${errorMessage(err)}`);
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

  // ── Outputs (physical screens + routing) ─────────────────────────────
  /**
   * A refused create or claim, as the outcome the panel shows. The server holds either
   * to the kind of view the operator was shown; when that changed, the views are read
   * again so the role line says what the view is now.
   */
  function createRefusal(err: unknown): CreateScreenOutcome {
    const viewChanged = (err as ApiError).code === "surface-changed";
    if (viewChanged) void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stageState });
    return { refused: errorMessage(err), outputId: null, ...(viewChanged ? { viewChanged } : {}) };
  }

  /**
   * Make a screen from the answers the Screen settings panel collected. Resolves
   * the id of the screen made, or why it was refused.
   *
   * Returned rather than toasted: the panel keeps its answers open after a
   * refusal (a taken friendly link, a view that does not fit) and says why where
   * the operator is already looking. Nothing is created until this is called, and
   * the server validates before it writes and puts back what it made if a later
   * step fails.
   */
  async function handleCreateScreen(input: CreateScreenInput): Promise<CreateScreenOutcome> {
    try {
      // The answer is the state and the id of the screen this call made.
      const { outputId, ...next } = await ipc<StageState & { outputId?: string }>("outputs:add", { ...input });
      queryClient.setQueryData(["stage:getState"], next);
      return { refused: null, outputId: outputId ?? null };
    } catch (err) {
      return createRefusal(err);
    }
  }

  /**
   * Make a screen for a waiting device and bind the device to it, as one call: the
   * server takes the screen back if the binding fails. The answer is the id of the
   * screen made, not the state.
   */
  async function handleClaimDevice(deviceId: string, input: CreateScreenInput): Promise<CreateScreenOutcome> {
    try {
      const claimed = await ipc<{ outputId?: string }>("devices:claim", { deviceId, outputId: null, ...input });
      return { refused: null, outputId: claimed?.outputId ?? null };
    } catch (err) {
      return createRefusal(err);
    }
  }

  async function handleRenameOutput(id: string, name: string) {
    await writeState("outputs:rename", { id, name }, { fail: "Failed to rename display" });
  }

  /**
   * One screen field, written optimistically: the switch, checkbox or picker
   * follows the operator's finger, and the cache reconciles to the server's
   * answer, or rolls back with `fail` toasted. For the fields the server refuses
   * only for an id that does not exist or a value out of range. Six handlers
   * were this, verbatim, each with its own copy to drift. `alsoSent` is what the
   * server is told beyond the field itself, which the cache has no use for.
   */
  function setOutputField(
    channel: IpcChannel,
    id: string,
    patch: Partial<Output>,
    fail: string,
    alsoSent: Record<string, unknown> = {},
  ): Promise<unknown> {
    return optimistic<StageState>(
      ["stage:getState"],
      (cur) => ({ ...cur, outputs: patchOutput(cur.outputs, id, patch) }),
      () => ipc<StageState>(channel, { id, ...patch, ...alsoSent }),
      fail,
    );
  }

  /** Optimistic so the controlled <Select> shows the new view at once instead
   *  of snapping back to the cached one while the request is in flight. */
  async function handleSetOutputView(id: string, viewId: string | null, expectSurface?: ViewSurface) {
    await setOutputField("outputs:setView", id, { viewId }, "Failed to route display", expectSurface ? { expectSurface } : {});
  }

  async function handleSetOutputLocked(id: string, locked: boolean) {
    await setOutputField("outputs:setLocked", id, { locked }, "Failed to update display lock");
  }

  /** Show or hide one display's kiosk top bar. */
  async function handleSetOutputHideTopBar(id: string, hideTopBar: boolean) {
    await setOutputField("outputs:setHideTopBar", id, { hideTopBar }, "Failed to update the display's top bar");
  }

  /** Allow or refuse HLS on one display's Video widgets. */
  async function handleSetOutputAllowHls(id: string, allowHls: boolean) {
    await setOutputField("outputs:setAllowHls", id, { allowHls }, "Failed to update the display's HLS setting");
  }

  /** Put one screen in message groups. The chips under the card's name follow. */
  async function handleSetOutputGroups(id: string, groups: string[]) {
    await setOutputField("outputs:setGroups", id, { groups }, "Failed to update the screen's groups");
  }

  /** List a control surface's view in the sidebar, or keep it out. Optimistic:
   *  the server refuses only an id that does not exist, and the switch has to
   *  follow the operator's finger. */
  async function handleSetViewShowInSidebar(id: string, showInSidebar: boolean) {
    await optimistic<StageState>(
      ["stage:getState"],
      (cur) => ({ ...cur, views: cur.views.map((v) => (v.id === id ? { ...v, showInSidebar } : v)) }),
      () => ipc<StageState>("views:setShowInSidebar", { id, showInSidebar }),
      "Failed to change whether the console is listed in the sidebar",
    );
  }

  /** Keep the ServiceCue text size a display shows; the server refuses a value
   *  outside 50 to 300. */
  async function handleSetOutputTextSize(id: string, textSize: number) {
    await setOutputField("outputs:setTextSize", id, { textSize }, "Failed to change the display's text size");
  }

  /** Turn what the Mac output helper sends for one screen. Optimistic, so the
   *  segmented control follows the finger; the server refuses only a value the
   *  control does not offer. */
  async function handleSetOutputRotation(id: string, rotation: Rotation) {
    await setOutputField("outputs:setRotation", id, { rotation }, "Failed to rotate the screen's output");
  }

  /** Choose the video mode a DeckLink port sends one screen in. */
  async function handleSetOutputVideoMode(id: string, videoMode: string) {
    await setOutputField("outputs:setVideoMode", id, { videoMode }, "Failed to change the screen's video mode");
  }

  /**
   * Change what a View is for, and with it EVERY screen showing it: the view
   * card's deliberate "all of them" path. A screen is a control surface when its
   * view is a console, so the view's surface is the one thing the server writes
   * (and puts back if it fails). What is left here is the question: when screens
   * would change, they are named first, declining sends nothing, and the ids of
   * the screens named go with the call. The server refuses when they are stale,
   * and changeViewRole asks once more with its list.
   *
   * Not optimistic: the server refuses some of these (a view that cannot be a
   * control surface), and an optimistic flip would show the change happening and
   * then silently undo it. The refusal is the useful part.
   */
  async function handleSetViewSurface(id: string, surface: "display" | "console") {
    try {
      await changeViewRole({
        state: stateNow(),
        viewId: id,
        surface,
        ask: confirm,
        send: async (screens) => {
          queryClient.setQueryData(["stage:getState"], await ipc<StageState>("views:setRole", { id, surface, screens }));
        },
      });
    } catch (err) {
      toast.error(`Failed to change what the view is for: ${errorMessage(err)}`);
    }
  }

  /** Resolves whether the screen is gone, for the same reason handleRemoveView does. */
  async function handleRemoveOutput(id: string): Promise<boolean> {
    return writeState("outputs:remove", { id }, { fail: "Failed to remove display" });
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
      toast.error(`Failed to refresh display: ${errorMessage(err)}`);
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
    handleSetPlanSwitcherMode,
    handleSetBranding,
    handleAddView,
    handleRenameView,
    handleDuplicateView,
    handleRemoveView,
    handleSetViewKind,
    handleSetViewLayout,
    handleSaveLayoutTemplate,
    handleUpdateLayoutTemplate,
    handleDeleteLayoutTemplate,
    handleCreateScreen,
    handleClaimDevice,
    handleRenameOutput,
    handleSetOutputView,
    handleSetOutputLocked,
    handleSetOutputHideTopBar,
    handleSetOutputAllowHls,
    handleSetOutputGroups,
    handleSetOutputTextSize,
    handleSetOutputRotation,
    handleSetOutputVideoMode,
    handleSetViewShowInSidebar,
    handleSetViewSurface,
    handleRemoveOutput,
    handleReorderOutputs,
    handleRefreshDisplay,
    sensors,
  };

  return {
    stageState,
    stageLoading,
    serviceTypes,
    plans,
    wirelessChannels,
    layoutTemplates,
    slotPresets,
    updateStatus,
    selectedViewId,
    setSelectedViewId,
    isRefreshing,
    handleDismissOnboarding,
    handlers,
  };
}
