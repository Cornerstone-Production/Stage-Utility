import { invoke, onNotification } from "../lib/api";
import { useState, useEffect } from "react";
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  SplitView,
  Sidebar,
  SidebarList,
  SidebarListItem,
  ScrollArea,
  toast,
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
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SectionItem, WirelessChannel, SectionHandlers } from "./types";
import { PlanSection } from "./sections/plan-section";
import { ServiceTypesSection } from "./sections/service-types-section";
import { ViewsSection } from "./sections/views-section";
import { OutputsSection } from "./sections/outputs-section";
import { IntegrationsSection } from "./sections/integrations-section";
import { ConnectSection } from "./sections/connect-section";
import { BrandingSection } from "./sections/branding-section";
import { BrandHeader } from "./brand-header";

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

// ---- sidebar section definitions --------------------------------------------

const SECTIONS: SectionItem[] = [
  { id: "plan", label: "Plan", icon: <CalendarIcon className="size-4 text-gray-11" /> },
  { id: "service-types", label: "Service Types", icon: <LayersIcon className="size-4 text-gray-11" /> },
  { id: "views", label: "Views", icon: <LayoutTemplateIcon className="size-4 text-gray-11" /> },
  { id: "displays", label: "Displays", icon: <MonitorIcon className="size-4 text-gray-11" /> },
  { id: "integrations", label: "Integrations", icon: <PlugIcon className="size-4 text-gray-11" /> },
  { id: "connect", label: "Connect", icon: <QrCodeIcon className="size-4 text-gray-11" /> },
  { id: "branding", label: "Branding", icon: <PaletteIcon className="size-4 text-gray-11" /> },
];

// ---- main settings view -----------------------------------------------------

export function SettingsView() {
  useEscapeToClose();
  const theme = useTheme();
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

  async function handleSetBranding(partial: {
    name?: string;
    logo?: string | null;
    monochrome?: boolean;
    logoOriginal?: string | null;
    logoCrop?: { scale: number; x: number; y: number } | null;
    emptyLogo?: string | null;
    emptyLogoOriginal?: string | null;
    emptyLogoCrop?: { scale: number; x: number; y: number } | null;
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
      device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null },
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

  async function handleSetViewNdiSource(id: string, ndiSource: string | null) {
    try {
      const next = await ipc<StageState>("views:setNdiSource", { id, ndiSource });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to set NDI source: ${String(err)}`);
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
    try {
      const next = await ipc<StageState>("outputs:setView", { id, viewId });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
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

  const handlers: SectionHandlers = {
    handleServiceTypeChange,
    handlePlanModeChange,
    handlePlanChange,
    handleNextPlan,
    handleRefresh,
    handleShowQrChange,
    handleSetAllowedServiceTypes,
    handleSetBranding,
    updateSlot,
    addSlot,
    removeSlot,
    saveSlots,
    handleAddView,
    handleRenameView,
    handleDuplicateView,
    handleRemoveView,
    handleSetViewKind,
    handleSetViewNdiSource,
    handleSetViewLayout,
    handleSaveLayoutTemplate,
    handleUpdateLayoutTemplate,
    handleDeleteLayoutTemplate,
    handleCopySlots,
    handleReorderViews,
    handleAddOutput,
    handleRenameOutput,
    handleSetOutputView,
    handleRemoveOutput,
    handleReorderOutputs,
    handleOpenOutputWindow,
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
    }
  }

  return (
    <SplitView
      storageKey="settings-view"
      sidebarSize={{ default: 200, min: 180, max: 240 }}
      sidebar={
        <Sidebar>
          {/* Brand header — big logo + name auto-fit to the logo's height. */}
          <BrandHeader
            name={stageState.appName}
            logo={stageState.appLogo}
            monochrome={stageState.appLogoMonochrome}
          />

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
      <ScrollArea className="h-full" title={activeSection.label}>{renderSection()}</ScrollArea>
    </SplitView>
  );
}
