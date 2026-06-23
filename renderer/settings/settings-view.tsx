import { invoke, onNotification } from "../lib/api";
import { useState, useEffect, useRef } from "react";
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  SplitView,
  Sidebar,
  SidebarList,
  SidebarListItem,
  ScrollArea,
  Button,
  toast,
  ErrorBoundary,
} from "../components/ui";
import {
  Loader2Icon,
  MonitorIcon,
  CalendarIcon,
  LayersIcon,
  LayoutTemplateIcon,
  PlugIcon,
  QrCodeIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  SunIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from "lucide-react";
import { useIsMobile } from "../lib/use-media-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SectionItem, WirelessChannel, SectionHandlers } from "./types";
import { PlanSection } from "./sections/plan-section";
import { ServiceTypesSection } from "./sections/service-types-section";
import { ViewsSection } from "./sections/views-section";
import { OutputsSection } from "./sections/outputs-section";
import { IntegrationsSection } from "./sections/integrations-section";
import { ConnectSection } from "./sections/connect-section";
import { BrandingSection } from "./sections/branding-section";
import { AdvancedSection } from "./sections/advanced-section";
import { BrandHeader } from "./brand-header";
import { BrandLogo } from "../components/brand-logo";

// ---- helpers ----------------------------------------------------------------

// sessionStorage handshake spanning the update restart: "pending" is written when
// the operator presses Update now; the post-restart page reads "done" to show a
// success banner. sessionStorage (not local) so it's scoped to this tab.
const UPDATE_PENDING_KEY = "stageUtility.update.pending";
const UPDATE_DONE_KEY = "stageUtility.update.done";

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

// ---- light / dark theme -----------------------------------------------------
//
// The `.dark` class on <html> drives the Radix color scales. The initial value
// is set by an inline script in settings-window.html (reading this same
// localStorage key) so there's no flash on load.

const THEME_STORAGE_KEY = "stage-utility-theme";

function useTheme() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  function toggle() {
    setIsDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
      } catch {
        // localStorage unavailable (private mode etc.) — theme still applies for this session.
      }
      return next;
    });
  }

  return { isDark, toggle };
}

// ---- sidebar collapse (desktop icon rail) -----------------------------------

const SIDEBAR_COLLAPSED_KEY = "settings-sidebar-collapsed";

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // localStorage unavailable — collapse still applies for this session.
      }
      return next;
    });
  }
  return { collapsed, toggle };
}

// ---- sidebar section definitions --------------------------------------------

const SECTIONS: SectionItem[] = [
  { id: "plan", label: "Plan", icon: <CalendarIcon className="size-4 text-gray-11" /> },
  { id: "service-types", label: "Service Types", icon: <LayersIcon className="size-4 text-gray-11" /> },
  { id: "views", label: "Views", icon: <LayoutTemplateIcon className="size-4 text-gray-11" /> },
  { id: "displays", label: "Displays", icon: <MonitorIcon className="size-4 text-gray-11" /> },
  { id: "integrations", label: "Integrations", icon: <PlugIcon className="size-4 text-gray-11" /> },
  { id: "connect", label: "Connect", icon: <QrCodeIcon className="size-4 text-gray-11" /> },
  { id: "branding", label: "Branding", icon: <PaletteIcon className="size-4 text-gray-11" /> },
  { id: "advanced", label: "Advanced", icon: <SlidersHorizontalIcon className="size-4 text-gray-11" /> },
];

// ---- main settings view -----------------------------------------------------

export function SettingsView() {
  useEscapeToClose();
  const theme = useTheme();
  const { collapsed, toggle: toggleCollapsed } = useSidebarCollapsed();
  const isMobile = useIsMobile();
  const railed = collapsed && !isMobile;
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

  // Fetch team positions for the position dropdown (depends on service type + PCO configured)
  const { data: teamPositions = [] } = useQuery({
    queryKey: ["stage:listTeamPositions", stageState?.serviceTypeId],
    queryFn: () => ipc<TeamPositionDTO[]>("stage:listTeamPositions"),
    enabled: !!stageState?.serviceTypeId && !!stageState?.pcoConfigured,
  });

  // Fetch wireless channels
  const { data: wirelessChannels = [] } = useQuery({
    queryKey: ["wireless:listChannels"],
    queryFn: () => ipc<WirelessChannel[]>("wireless:listChannels"),
  });

  // Fetch reusable custom-layout templates
  const { data: layoutTemplates = [] } = useQuery({
    queryKey: ["layoutTemplates:list"],
    queryFn: () => ipc<LayoutTemplate[]>("layoutTemplates:list"),
  });

  // Fetch saved slot arrangements (presets — global, recall into any view)
  const { data: slotPresets = [] } = useQuery({
    queryKey: ["presets:list"],
    queryFn: () => ipc<SlotPreset[]>("presets:list"),
  });

  // In-app update status (git-based; surfaced in the Advanced tab).
  const { data: updateStatus = null } = useQuery({
    queryKey: ["update:status"],
    queryFn: () => ipc<UpdateStatus>("update:status"),
  });

  // Tracks the running server's code version (from server:hello). Used to detect
  // that an in-app update finished: the post-restart hello carries a new version.
  const serverVersionRef = useRef<string | null>(null);
  // Set once on mount from the handshake the pre-restart page left behind, so the
  // Updates panel can show a "successfully updated" banner after the auto-reload.
  const [justUpdated, setJustUpdated] = useState<{ version: string } | null>(() => {
    try {
      const raw = sessionStorage.getItem(UPDATE_DONE_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(UPDATE_DONE_KEY);
      return JSON.parse(raw) as { version: string };
    } catch {
      return null;
    }
  });

  // Detect update completion across the server restart: a server:hello whose
  // version differs from the one captured when we pressed "Update now" means the
  // new build is live → record it and reload this page to load the new assets.
  useEffect(() => {
    return onNotification("server:hello", (payload: unknown) => {
      const version = (payload as { version?: string } | null)?.version ?? null;
      if (!version || version === "unknown") return;
      if (serverVersionRef.current === null) serverVersionRef.current = version;
      let pending: { fromVersion: string | null } | null = null;
      try {
        const raw = sessionStorage.getItem(UPDATE_PENDING_KEY);
        pending = raw ? (JSON.parse(raw) as { fromVersion: string | null }) : null;
      } catch {
        pending = null;
      }
      if (pending && version !== pending.fromVersion) {
        try {
          sessionStorage.removeItem(UPDATE_PENDING_KEY);
          sessionStorage.setItem(UPDATE_DONE_KEY, JSON.stringify({ version }));
        } catch {
          /* ignore */
        }
        // Brief beat so the "restarting" step paints before the reload.
        setTimeout(() => window.location.reload(), 900);
      }
    });
  }, []);

  // Selected View for the Views tab master-detail (default to the first view).
  const [selectedViewId, setSelectedViewId] = useState<string>("");

  useEffect(() => {
    if (!stageState) return;
    const views = stageState.views ?? [];
    if (views.length === 0) {
      if (selectedViewId) setSelectedViewId("");
      return;
    }
    if (!selectedViewId || !views.find((v) => v.id === selectedViewId)) {
      setSelectedViewId(views[0].id);
    }
  }, [stageState, selectedViewId]);

  // Local slot editor state
  const [localSlots, setLocalSlots] = useState<Slot[]>([]);
  const [slotsDirty, setSlotsDirty] = useState(false);
  const [isSavingSlots, setIsSavingSlots] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Mirror the selected View's resolved slots into the editor (unless dirty).
  useEffect(() => {
    if (!stageState || slotsDirty) return;
    const viewSlots = stageState.slotsByView?.[selectedViewId] ?? [];
    setLocalSlots([...viewSlots].sort((a, b) => a.order - b.order));
  }, [stageState, selectedViewId, slotsDirty]);

  // Subscribe to live state changes from backend
  useEffect(() => {
    const unsub = onNotification("stage:state-changed", (payload: unknown) => {
      const s = payload as StageState;
      queryClient.setQueryData(["stage:getState"], s);
    });
    return unsub;
  }, [queryClient]);

  // Live update-status pushes (availability check, apply progress).
  useEffect(() => {
    const unsub = onNotification("update:status", (payload: unknown) => {
      queryClient.setQueryData(["update:status"], payload as UpdateStatus);
    });
    return unsub;
  }, [queryClient]);

  // When Planning Center connects, refetch service types and plans
  useEffect(() => {
    const unsub = onNotification("integrations:state-changed", (payload: unknown) => {
      const states = payload as IntegrationState[];
      const pco = states.find((s) => s.id === "planning-center");
      if (pco?.connection === "connected") {
        queryClient.invalidateQueries({ queryKey: ["stage:listServiceTypes"] });
        queryClient.invalidateQueries({ queryKey: ["stage:getState"] });
        queryClient.invalidateQueries({ queryKey: ["stage:listPlans"] });
      }
    });
    return unsub;
  }, [queryClient]);

  // DnD sensors
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

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
      if (!status.isGitRepo) toast.error("Not a git install — update from the command line.");
      else if (status.error) toast.error(`Update check failed: ${status.error}`);
      else if (status.behind > 0) toast.success(`${status.behind} update${status.behind === 1 ? "" : "s"} available.`);
      else toast.success("You're up to date.");
    } catch (err) {
      toast.error(`Update check failed: ${String(err)}`);
    }
  }

  async function handleApplyUpdate() {
    try {
      const status = await ipc<UpdateStatus>("update:apply");
      queryClient.setQueryData(["update:status"], status);
      // Remember the version we're updating FROM, so the server:hello after the
      // restart (carrying a new version) tells us the apply finished — then we
      // reload this page to pick up the new assets and show a success banner.
      try {
        sessionStorage.setItem(
          UPDATE_PENDING_KEY,
          JSON.stringify({ fromVersion: serverVersionRef.current, at: Date.now() }),
        );
      } catch {
        /* ignore */
      }
      toast.success("Updating… this page will reload automatically when it's done.");
    } catch (err) {
      toast.error(`Failed to start update: ${String(err)}`);
    }
  }

  async function handleSetAutoUpdate(partial: { enabled?: boolean; dayOfWeek?: number | null; hour?: number }) {
    try {
      const next = await ipc<StageState>("update:setAuto", partial);
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update auto-update settings: ${String(err)}`);
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
      link: { kind: "pco", matchBy: "position", teamPositionName: "" },
      deviceBinding: null,
      displayName: null,
      photoUrl: null,
      device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null },
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
      device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null },
    };
    setLocalSlots((prev) => [...prev, newSlot]);
    setSlotsDirty(true);
  }

  function removeSlot(idx: number) {
    setLocalSlots((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i })));
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

  // ── Views (content) ──────────────────────────────────────────────────
  async function handleAddView(name: string, kind: ViewKind) {
    try {
      const next = await ipc<StageState>("views:add", { name, kind });
      queryClient.setQueryData(["stage:getState"], next);
      // Select the newly-created view (last in the list).
      const created = next.views?.[next.views.length - 1];
      if (created) setSelectedViewId(created.id);
    } catch (err) {
      toast.error(`Failed to add view: ${String(err)}`);
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

  async function handleSetViewLayout(id: string, layout: LayoutDTO) {
    try {
      const next = await ipc<StageState>("views:setLayout", { id, layout });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
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
      const presets = await ipc<SlotPreset[]>("presets:save", { name, displayId: selectedViewId });
      queryClient.setQueryData(["presets:list"], presets);
      toast.success(`Saved arrangement "${name}".`);
    } catch (err) {
      toast.error(`Failed to save arrangement: ${String(err)}`);
    }
  }

  async function handleApplyPreset(id: string) {
    try {
      const next = await ipc<StageState>("presets:apply", { id, displayId: selectedViewId });
      queryClient.setQueryData(["stage:getState"], next);
      const viewSlots = next.slotsByView?.[selectedViewId] ?? [];
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
    handleSetAllowedServiceTypes,
    handleSetBranding,
    updateSlot,
    addSlot,
    addSpacer,
    removeSlot,
    saveSlots,
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
    handleRemoveOutput,
    handleReorderOutputs,
    handleOpenOutputWindow,
    handleRefreshDisplay,
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
          <ServiceTypesSection stageState={stageState} serviceTypes={serviceTypes} handlers={handlers} />
        );
      case "views":
        return (
          <ViewsSection
            stageState={stageState}
            wirelessChannels={wirelessChannels}
            teamPositions={teamPositions}
            layoutTemplates={layoutTemplates}
            selectedViewId={selectedViewId}
            setSelectedViewId={setSelectedViewId}
            localSlots={localSlots}
            slotsDirty={slotsDirty}
            isSavingSlots={isSavingSlots}
            slotPresets={slotPresets}
            handlers={handlers}
          />
        );
      case "displays":
        return <OutputsSection stageState={stageState} handlers={handlers} />;
      case "integrations":
        return <IntegrationsSection />;
      case "connect":
        return <ConnectSection stageState={stageState} handlers={handlers} />;
      case "branding":
        return <BrandingSection stageState={stageState} handlers={handlers} />;
      case "advanced":
        return <AdvancedSection stageState={stageState} updateStatus={updateStatus} handlers={handlers} justUpdated={justUpdated} onDismissJustUpdated={() => setJustUpdated(null)} />;
    }
  }

  return (
    <SplitView
      collapsed={collapsed}
      mobileTitle={activeSection.label}
      sidebar={
        <Sidebar>
          {/* Header row: brand (expanded) or just the expand toggle (rail). The
              desktop collapse toggle is hidden on mobile (the drawer is always
              shown expanded). */}
          {railed ? (
            <div className="flex flex-col items-center gap-1.5 pt-2">
              {stageState.appLogo && (
                <BrandLogo
                  logo={stageState.appLogo}
                  monochrome={stageState.appLogoMonochrome}
                  className="size-8 rounded-md text-gray-12"
                />
              )}
              <Button variant="transparent" size="small" iconOnly aria-label="Expand sidebar" onClick={toggleCollapsed}>
                <PanelLeftOpenIcon className="size-4 text-gray-11" />
              </Button>
            </div>
          ) : (
            <div className="flex items-start">
              <div className="flex-1 min-w-0">
                <BrandHeader
                  name={stageState.appName}
                  logo={stageState.appLogo}
                  monochrome={stageState.appLogoMonochrome}
                />
              </div>
              <Button
                variant="transparent"
                size="small"
                iconOnly
                aria-label="Collapse sidebar"
                onClick={toggleCollapsed}
                className="max-sm:hidden mt-2.5 mr-1.5 shrink-0"
              >
                <PanelLeftCloseIcon className="size-4 text-gray-11" />
              </Button>
            </div>
          )}

          <SidebarList
            items={SECTIONS}
            selectedItem={activeSection}
            onSelectedItemChange={setActiveSection}
            getItemKey={(s: SectionItem) => s.id}
          >
            {SECTIONS.map((section) => (
              <SidebarListItem key={section.id} item={section} icon={section.icon} title={section.label} />
            ))}
          </SidebarList>

          {/* Light / dark toggle, pinned to the bottom of the sidebar. */}
          <div className="mt-auto p-2">
            <SidebarListItem
              icon={
                theme.isDark ? (
                  <SunIcon className="size-4 text-gray-11" />
                ) : (
                  <MoonIcon className="size-4 text-gray-11" />
                )
              }
              title={theme.isDark ? "Light mode" : "Dark mode"}
              onClick={theme.toggle}
            />
          </div>
        </Sidebar>
      }
    >
      <ScrollArea className="h-full" title={activeSection.label}>
        {/* Keep a render error in one section from blanking the whole window. Keyed
            by the active tab so switching sections resets the boundary. */}
        <ErrorBoundary key={activeSection.id}>{renderSection()}</ErrorBoundary>
      </ScrollArea>
    </SplitView>
  );
}
