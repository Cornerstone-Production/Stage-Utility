import { invoke, onNotification } from "../lib/api";
import { buildLabel } from "../lib/build-label";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useState, useEffect, useRef, useMemo, Fragment } from "react";
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import {
  SplitView,
  Sidebar,
  SidebarList,
  SidebarListItem,
  SidebarGroupLabel,
  ScrollArea,
  Button,
  Tooltip,
  toast,
  ErrorBoundary,
} from "../components/ui";
import {
  Loader2Icon,
  MonitorIcon,
  CalendarIcon,
  LayoutTemplateIcon,
  CableIcon,
  PlugIcon,
  QrCodeIcon,
  PaletteIcon,
  ClockIcon,
  DropletIcon,
  ListChecksIcon,
  ZapIcon,
  SlidersHorizontalIcon,
  SunIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { useIsMobile } from "../lib/use-media-query";
import { withViewTransition } from "../lib/view-transition";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SectionItem, WirelessChannel, SectionHandlers } from "./types";
import { PlanSection } from "./sections/plan-section";
import { ViewsSection } from "./sections/views-section";
import { OutputsSection } from "./sections/outputs-section";
import { IntegrationsSection } from "./sections/integrations-section";
import { ConnectSection } from "./sections/connect-section";
import { BrandingSection } from "./sections/branding-section";
import { applyAccentVar } from "../lib/apply-accent";
import { cn } from "../lib/cn";
import { AdvancedSection } from "./sections/advanced-section";
import { AutomationSection } from "./sections/automation-section";
import { ServiceHistorySection } from "./sections/service-history-section";
import { PatchSection } from "./sections/patch-section";
import { ScriptViewSection } from "./sections/scriptview-section";
import { BaptismsSection } from "./sections/baptisms-section";
import { GettingStarted } from "./getting-started";
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

/** "system" follows the OS and keeps following it as the OS changes. */
export type ThemeMode = "system" | "light" | "dark";

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function storedMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to system.
  }
  // No stored choice means the app has always followed the OS, so an install that
  // predates this option keeps the behaviour it already had.
  return "system";
}

function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  // One place decides what `.dark` should be, so the class can never disagree with
  // the mode — whether it changed because the operator picked one or because the OS
  // flipped underneath us.
  useEffect(() => {
    const mq = window.matchMedia(SYSTEM_DARK);
    const apply = () => {
      const dark = mode === "system" ? mq.matches : mode === "dark";
      document.documentElement.classList.toggle("dark", dark);
      setIsDark(dark);
    };
    apply();
    if (mode !== "system") return;
    // Only worth listening while following the OS; a fixed choice ignores it.
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Theme still applies for this session; it just will not survive a reload.
    }
  }

  return { mode, isDark, setMode };
}

// ---- sidebar collapse (desktop icon rail) -----------------------------------

const SIDEBAR_COLLAPSED_KEY = "settings-sidebar-collapsed";

/** Segmented theme picker — light, follow the system, dark. `vertical` stacks the
 *  segments so it fits the narrow collapsed rail. */
function ThemeTogglePill({
  mode,
  setMode,
  vertical = false,
}: {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  vertical?: boolean;
}) {
  const options: { m: ThemeMode; label: string; Icon: typeof SunIcon }[] = [
    { m: "light", label: "Light mode", Icon: SunIcon },
    { m: "system", label: "Match system", Icon: MonitorIcon },
    { m: "dark", label: "Dark mode", Icon: MoonIcon },
  ];
  return (
    <div className={cn("flex items-center gap-px rounded-lg bg-accent/12 p-0.5 shrink-0", vertical && "flex-col")}>
      {options.map(({ m, label, Icon }) => (
        <button
          key={m}
          type="button"
          onClick={() => mode !== m && setMode(m)}
          aria-label={label}
          aria-pressed={mode === m}
          className={cn(
            "flex h-5 w-6 items-center justify-center rounded-md transition-colors",
            mode === m ? "text-accent" : "text-fg-subtle hover:text-fg",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

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
  { id: "plan", label: "Plan", icon: <CalendarIcon className="size-4" /> },
  { id: "views", label: "Views", icon: <LayoutTemplateIcon className="size-4" /> },
  { id: "scriptview", label: "ScriptView", icon: <ListChecksIcon className="size-4" /> },
  { id: "displays", label: "Displays", icon: <MonitorIcon className="size-4" /> },
  { id: "integrations", label: "Integrations", icon: <PlugIcon className="size-4" /> },
  { id: "patch", label: "Patch", icon: <CableIcon className="size-4" /> },
  { id: "connect", label: "Connect", icon: <QrCodeIcon className="size-4" /> },
  { id: "branding", label: "Branding", icon: <PaletteIcon className="size-4" /> },
  { id: "service-history", label: "History", icon: <ClockIcon className="size-4" /> },
  { id: "baptisms", label: "Baptisms", icon: <DropletIcon className="size-4" /> },
  { id: "automation", label: "Automation", icon: <ZapIcon className="size-4" /> },
  { id: "advanced", label: "Advanced", icon: <SlidersHorizontalIcon className="size-4" /> },
];

// Per-tab header subtitles (shown under the section title in the content pane).
const SECTION_DESC: Record<string, string> = {
  plan: "Choose which Planning Center plan the displays follow.",
  views: "Build and arrange what each display shows.",
  scriptview: "Named rundown column presets for the ScriptView dashboard.",
  displays: "Point each physical screen at a View.",
  integrations: "Connect the gear and services that run your service.",
  connect: "Share the display link and QR for phones on the network.",
  branding: "Your organization's name, logo, and accent color.",
  "service-history": "Every service you've run — timing and attendance.",
  baptisms: "Time testimonies and baptisms live.",
  patch: "Stage input & output patch — record it, and surface each week's to volunteers.",
  automation: "When something happens in Stage, do something to a device.",
  advanced: "Updates, network address, capture windows, and full config.",
};

// Nav clusters. Each group answers one question, which is what the previous set of
// labels did not: "Output" had collected anything screen-adjacent (Patch is a
// document, Integrations are devices), and "Identity" had become the bucket for the
// two sections that fit nowhere — including Baptisms, which is a live stopwatch.
const NAV_GROUPS: { label: string; ids: string[] }[] = [
  // What is shown. Patch belongs here because volunteers READ it at /patch; the
  // "output" in its description is XLR, not a display.
  { label: "Content", ids: ["plan", "views", "scriptview", "patch"] },
  // Where it shows. Connect is a phone rather than a monitor, but it is the same
  // job — getting the app onto a screen — not machine configuration.
  { label: "Screens", ids: ["displays", "connect"] },
  // What it talks to. Automation rules act ON integrations, so configuring a device
  // and configuring its behaviour sit together instead of three tabs apart.
  { label: "Devices", ids: ["integrations", "automation"] },
  // A service you ran — one live, one recorded.
  { label: "Services", ids: ["service-history", "baptisms"] },
  // The install itself.
  { label: "System", ids: ["branding", "advanced"] },
];

// ---- main settings view -----------------------------------------------------

export function SettingsView() {
  useEscapeToClose();
  const theme = useTheme();
  const { collapsed, toggle: toggleCollapsed } = useSidebarCollapsed();
  const isMobile = useIsMobile();
  const railed = collapsed && !isMobile;
  const queryClient = useQueryClient();

  // Restore the tab from the URL hash (e.g. #integrations) so a refresh stays put
  // and tabs are deep-linkable; otherwise open on Views (a better first-run landing
  // than Plan, which assumes PCO). Sidebar order is unchanged — this is only the
  // default active tab.
  const [activeSection, setActiveSection] = useState<SectionItem>(() => {
    const id = window.location.hash.replace(/^#/, "");
    const fallback = SECTIONS.find((s) => s.id === "views") ?? SECTIONS[0];
    return SECTIONS.find((s) => s.id === id) ?? fallback;
  });
  // Bumped whenever the History nav is clicked so the section remounts back to its
  // landing list (instead of staying on the service you'd drilled into).
  const [historyNonce, setHistoryNonce] = useState(0);

  // Mirror the active tab into the URL hash. replaceState keeps tab-switching out
  // of the history stack (so Back leaves Settings rather than cycling tabs).
  useEffect(() => {
    if (window.location.hash.replace(/^#/, "") !== activeSection.id) {
      window.history.replaceState(null, "", `#${activeSection.id}`);
    }
  }, [activeSection]);

  // Follow external hash changes (manual edit / deep link opened in-session).
  useEffect(() => {
    const onHash = () => {
      const id = window.location.hash.replace(/^#/, "");
      const next = SECTIONS.find((s) => s.id === id);
      if (next) setActiveSection((cur) => (cur.id === next.id ? cur : next));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Fetch current stage state
  const { data: stageState, isLoading: stageLoading } = useQuery({
    queryKey: ["stage:getState"],
    queryFn: () => ipc<StageState>("stage:getState"),
  });

  // Apply the themeable brand accent to the settings root as it changes.
  useEffect(() => {
    applyAccentVar(stageState?.accentColor);
  }, [stageState?.accentColor]);

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

  // The unified History tab shows whenever PCO is configured or there's any recorded
  // data (service timing, attendance, or SPL) — so past history stays reachable even
  // after the recording integration is powered off/disabled.
  const { data: splHistoryList } = useQuery({
    queryKey: ["spl:listHistory"],
    queryFn: () => ipc<ServiceSplHistory[]>("spl:listHistory"),
  });
  const { data: attendanceList } = useQuery({
    queryKey: ["attendance:listHistory"],
    queryFn: () => ipc<ServiceAttendance[]>("attendance:listHistory"),
  });
  const { data: timelineList } = useQuery({
    queryKey: ["serviceTimeline:list"],
    queryFn: () => ipc<ServiceTimeline[]>("serviceTimeline:list"),
  });
  const showHistory =
    (stageState?.pcoConfigured ?? false) ||
    (timelineList?.length ?? 0) > 0 ||
    (attendanceList?.length ?? 0) > 0 ||
    (splHistoryList?.length ?? 0) > 0;
  const sections = useMemo(
    () => SECTIONS.filter((s) => s.id !== "service-history" || showHistory),
    [showHistory],
  );

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
  // One-shot guard so the two completion signals (server:hello version change and
  // update:status returning to idle after the restart) can't double-reload.
  const reloadScheduledRef = useRef(false);
  const hasPendingUpdate = () => {
    try {
      return !!sessionStorage.getItem(UPDATE_PENDING_KEY);
    } catch {
      return false;
    }
  };
  /** The update we kicked off has finished and the new build is live → record the
   *  success banner and reload once to swap in the new assets. */
  const finishUpdateAndReload = (version: string | null) => {
    if (reloadScheduledRef.current) return;
    reloadScheduledRef.current = true;
    try {
      sessionStorage.removeItem(UPDATE_PENDING_KEY);
      if (version) sessionStorage.setItem(UPDATE_DONE_KEY, JSON.stringify({ version }));
    } catch {
      /* ignore */
    }
    // Brief beat so the "restarting" step paints before the reload.
    setTimeout(() => window.location.reload(), 900);
  };

  // Detect update completion across the server restart: a server:hello whose
  // version differs from the one captured when we pressed "Update now" means the
  // new build is live → record it and reload this page to load the new assets.
  useEffect(() => {
    return onNotification("server:hello", (payload: unknown) => {
      const version = (payload as { version?: string } | null)?.version ?? null;
      if (!version || version === "unknown") return;
      if (serverVersionRef.current === null) serverVersionRef.current = version;
      let pending: { fromVersion: string | null } | null;
      try {
        const raw = sessionStorage.getItem(UPDATE_PENDING_KEY);
        pending = raw ? (JSON.parse(raw) as { fromVersion: string | null }) : null;
      } catch {
        pending = null;
      }
      if (pending && version !== pending.fromVersion) {
        finishUpdateAndReload(version);
      }
    });
  }, []);

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

  // Subscribe to live state changes from backend
  useEffect(() => {
    const unsub = onNotification("stage:state-changed", (payload: unknown) => {
      const s = payload as StageState;
      queryClient.setQueryData(["stage:getState"], s);
    });
    return unsub;
  }, [queryClient]);

  // Live update-status pushes (availability check, apply progress). This channel
  // now hydrates on every SSE (re)connect, so the post-restart reconnect delivers
  // the finished state here even if the server:hello reload was missed: if we had
  // an update in flight and it's no longer "updating" (and didn't error), the new
  // build is live → reload to pick up its assets. This is the durable completion
  // signal; the server:hello handler above is the faster path when it fires.
  useEffect(() => {
    const unsub = onNotification("update:status", (payload: unknown) => {
      const status = payload as UpdateStatus;
      queryClient.setQueryData(["update:status"], status);
      if (hasPendingUpdate() && status.phase !== "updating") {
        if (status.error) {
          // Failed apply — server stayed on the old build. Clear the flag and let
          // the panel show the error rather than reloading.
          try {
            sessionStorage.removeItem(UPDATE_PENDING_KEY);
          } catch {
            /* ignore */
          }
        } else {
          finishUpdateAndReload(status.version ?? null);
        }
      }
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

  async function handleDismissOnboarding() {
    try {
      const next = await ipc<StageState>("stage:setOnboardingDismissed", { dismissed: true });
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to dismiss: ${String(err)}`);
    }
  }

  // Jump to another settings section (with the same crossfade as the sidebar).
  function navigateToSection(id: string) {
    const sec = sections.find((s) => s.id === id);
    if (sec) withViewTransition(() => setActiveSection(sec));
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

  async function handleApplyUpdate(override = false) {
    try {
      const status = await ipc<UpdateStatus>("update:apply", { override });
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

  async function handleSetBaptismAutoStart(partial: { enabled?: boolean; testimonyKeyword?: string }) {
    try {
      const next = await ipc<StageState>("settings:setBaptismAutoStart", partial);
      queryClient.setQueryData(["stage:getState"], next);
    } catch (err) {
      toast.error(`Failed to update baptism auto-start: ${String(err)}`);
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
    handleSetBaptismAutoStart,
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
          <>
            {!stageState.onboardingDismissed && (
              <GettingStarted
                stageState={stageState}
                onNavigate={navigateToSection}
                onDismiss={handleDismissOnboarding}
              />
            )}
            <PlanSection
              stageState={stageState}
              serviceTypes={serviceTypes}
              plans={plans}
              isRefreshing={isRefreshing}
              handlers={handlers}
            />
          </>
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
            resolvedDraftSlots={resolvedDraftSlots}
            slotPresets={slotPresets}
            handlers={handlers}
          />
        );
      case "scriptview":
        return <ScriptViewSection />;
      case "displays":
        return <OutputsSection stageState={stageState} handlers={handlers} />;
      case "integrations":
        return <IntegrationsSection />;
      case "connect":
        return <ConnectSection stageState={stageState} handlers={handlers} />;
      case "branding":
        return <BrandingSection stageState={stageState} handlers={handlers} />;
      case "service-history":
        return (
          <div className="px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh]">
            <ServiceHistorySection key={historyNonce} />
          </div>
        );
      case "baptisms":
        return (
          <div className="px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh]">
            <BaptismsSection stageState={stageState} />
          </div>
        );
      case "patch":
        return (
          <div className="px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh]">
            <PatchSection />
          </div>
        );
      case "automation":
        return <AutomationSection />;
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
            stageState.appLogo ? (
              <div className="flex flex-col items-center pt-2">
                <BrandLogo
                  logo={stageState.appLogo}
                  monochrome={stageState.appLogoMonochrome}
                  className="size-8 rounded-md text-gray-12"
                />
              </div>
            ) : null
          ) : (
            <BrandHeader
              name={stageState.appName}
              logo={stageState.appLogo}
              monochrome={stageState.appLogoMonochrome}
            />
          )}

          <SidebarList
            items={sections}
            selectedItem={activeSection}
            onSelectedItemChange={(s: SectionItem) => withViewTransition(() => {
              if (s.id === "service-history") setHistoryNonce((n) => n + 1);
              setActiveSection(s);
            })}
            getItemKey={(s: SectionItem) => s.id}
          >
            {NAV_GROUPS.map((g) => {
              const items = sections.filter((s) => g.ids.includes(s.id));
              if (items.length === 0) return null;
              return (
                <Fragment key={g.label}>
                  <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
                  {items.map((section) => (
                    <SidebarListItem key={section.id} item={section} icon={section.icon} title={section.label} />
                  ))}
                </Fragment>
              );
            })}
          </SidebarList>

          {/* Footer: theme toggle + the sidebar collapse control (moved here from
              the cramped header). Rail-aware — collapsed stacks a compact toggle
              over the expand button so the wide pill + version never clip the
              narrow rail. */}
          {railed ? (
            <div className="mt-auto flex flex-col items-center gap-1.5 px-2 py-2.5">
              <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} vertical />
              <Button variant="transparent" size="small" iconOnly aria-label="Expand sidebar" onClick={toggleCollapsed}>
                <PanelLeftOpenIcon className="size-4 text-gray-11" />
              </Button>
            </div>
          ) : (
            <div className="mt-auto flex items-center justify-between gap-2 px-3 py-2.5">
              {/* The label truncates in the sidebar, so the hover carries the whole
                  build identity — version, track, commit and date. That is what gets
                  asked for when something needs diagnosing, and it saves opening
                  Advanced to read it. */}
              <Tooltip label={buildLabel(updateStatus)} side="top">
                <span className="min-w-0 text-[11.5px] leading-none text-fg-subtle tabular-nums truncate">
                  {updateStatus?.version ? `v${updateStatus.version}` : ""}
                  {updateStatus?.branch ? ` · ${updateStatus.branch}` : ""}
                </span>
              </Tooltip>
              <div className="flex items-center gap-1.5 shrink-0">
                <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} />
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label="Collapse sidebar"
                  onClick={toggleCollapsed}
                  className="max-sm:hidden"
                >
                  <PanelLeftCloseIcon className="size-4 text-gray-11" />
                </Button>
              </div>
            </div>
          )}
        </Sidebar>
      }
    >
      <ScrollArea className="h-full">
        {/* Per-tab header (title + subtitle), matching the mockup. */}
        <header className="px-5 max-sm:px-3 pt-6 max-sm:pt-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-title2 font-semibold text-fg leading-tight">{activeSection.label}</h1>
            {SECTION_DESC[activeSection.id] && (
              <p className="text-footnote text-fg-muted mt-1 max-w-[68ch]">{SECTION_DESC[activeSection.id]}</p>
            )}
          </div>
          {activeSection.id === "scriptview" && (
            <a
              href="/scriptview"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-caption1 text-fg-muted transition-colors hover:bg-fill hover:text-fg"
            >
              Open ScriptView <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
          {activeSection.id === "patch" && (
            <a
              href="/patch"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-caption1 text-fg-muted transition-colors hover:bg-fill hover:text-fg"
            >
              Open patch sheet <ExternalLinkIcon className="size-3.5" />
            </a>
          )}
        </header>
        {/* Keep a render error in one section from blanking the whole window. Keyed
            by the active tab so switching sections resets the boundary. */}
        <ErrorBoundary key={activeSection.id}>{renderSection()}</ErrorBoundary>
      </ScrollArea>
    </SplitView>
  );
}
