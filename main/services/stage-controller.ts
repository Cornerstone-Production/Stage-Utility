// Single source of truth for all stage state.
// Every mutating method ends with broadcast("stage:state-changed").

import { randomUUID } from "crypto";

import type { AutoUpdateSettings, ChargerBayDTO, DisplayInfo, LayoutDTO, LayoutGroup, LayoutObject, LayoutTemplate, Output, PcoAttachmentDTO, PcoLiveDTO, PlanDTO, PlanItemsDTO, ResolvedOutput, ScriptViewLayout, ScriptViewRundownDTO, ServiceTypeDTO, Slot, SlotPreset, SlotsLayout, StageState, TeamMemberDTO, TeamPositionDTO, View, ViewKind } from "../types/stage.js";
import type { DeviceStatus } from "../types/devices.js";
import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { pcoService } from "./pco-service.js";
import { presetsStore } from "./presets-store.js";
import { resolveSlots } from "./slot-resolver.js";
import { settingsStore } from "./settings-store.js";
import { slotsStore } from "./slots-store.js";
import { viewsStore } from "./views-store.js";
import { layoutGroupsStore } from "./layout-groups-store.js";
import { scriptViewLayoutsStore } from "./scriptview-layouts-store.js";
import { layoutTemplatesStore } from "./layout-templates-store.js";
import { updater } from "./updater.js";

const PRIMARY_DISPLAY_ID = "display-1";

// Coalescing window (ms) for live device-status updates. Wireless metering arrives
// ~1/sec per channel; we collapse bursts into one re-resolve+broadcast per window
// so the event loop isn't saturated, while keeping the RF bars visually live.
const DEVICE_STATUS_FLUSH_MS = 150;

/** Deep-clone a layout, minting fresh object ids so copies stay independent. */
/** Normalize a user-entered base URL: trim, default to http:// if no scheme,
 *  strip a trailing slash. Returns null for blank input. */
function normalizeBaseUrl(url: string | null): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

// Deep-clone an object and its whole subtree, minting a fresh id at every depth.
// Nested children must be cloned too, or duplicated Views/templates would share
// child object references and collide on child ids.
function cloneLayoutObject(o: LayoutObject): LayoutObject {
  return {
    ...o,
    id: randomUUID(),
    style: o.style ? { ...o.style } : undefined,
    config: { ...o.config },
    children: o.children?.map(cloneLayoutObject),
  };
}

function cloneLayout(l: LayoutDTO): LayoutDTO {
  return {
    version: 1,
    canvas: { ...l.canvas },
    objects: l.objects.map(cloneLayoutObject),
  };
}

// Like cloneLayoutObject, but records each old→new id so callers can carry
// per-object side data (e.g. inline mic-slots stored by object id) to the copy.
function cloneLayoutObjectMapped(o: LayoutObject, idMap: Map<string, string>): LayoutObject {
  const id = randomUUID();
  idMap.set(o.id, id);
  return {
    ...o,
    id,
    style: o.style ? { ...o.style } : undefined,
    config: { ...o.config },
    children: o.children?.map((c) => cloneLayoutObjectMapped(c, idMap)),
  };
}

function cloneLayoutWithMap(l: LayoutDTO): { layout: LayoutDTO; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const layout: LayoutDTO = { version: 1, canvas: { ...l.canvas }, objects: l.objects.map((o) => cloneLayoutObjectMapped(o, idMap)) };
  return { layout, idMap };
}

// Visit every inline mic-slots object id across all custom views' layouts (a
// `slots-grid` with source "inline"); recurses into container children.
function forEachInlineSlotsGrid(views: View[], cb: (objectId: string) => void): void {
  const walk = (objs: LayoutObject[]): void => {
    for (const o of objs) {
      if (o.config.type === "slots-grid" && o.config.source === "inline") cb(o.id);
      if (o.children?.length) walk(o.children);
    }
  };
  for (const v of views) if (v.kind === "custom" && v.layout) walk(v.layout.objects);
}

function defaultViewName(kind: ViewKind): string {
  switch (kind) {
    case "dashboard": return "Dashboard";
    case "stage": return "Stage";
    case "transcription": return "Transcription";
    case "custom": return "Custom";
    default: return "Slots";
  }
}

/** A sensible starting layout for a new custom View — proves the schema and
 *  gives the editor something to manipulate (clock, countdown, slide text). */
function defaultCustomLayout(): LayoutDTO {
  const obj = (
    config: LayoutDTO["objects"][number]["config"],
    x: number, y: number, w: number, h: number,
    style: LayoutDTO["objects"][number]["style"],
  ): LayoutDTO["objects"][number] => ({ id: randomUUID(), x, y, w, h, z: 1, config, style });
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#080810" },
    objects: [
      obj({ type: "clock", showSeconds: true, format: "12h" }, 0.04, 0.05, 0.34, 0.13,
        { fontSize: 0.11, fontWeight: 600, color: "#ffffff", textAlign: "left", vAlign: "middle" }),
      obj({ type: "countdown-timer" }, 0.62, 0.05, 0.34, 0.13,
        { fontSize: 0.11, fontWeight: 600, color: "#7fe3c4", textAlign: "right", vAlign: "middle" }),
      obj({ type: "current-slide-text" }, 0.08, 0.34, 0.84, 0.34,
        { fontSize: 0.11, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", textShadow: 0.6, lineClamp: 4 }),
      obj({ type: "next-slide-text" }, 0.08, 0.72, 0.84, 0.10,
        { fontSize: 0.05, color: "rgba(255,255,255,0.6)", textAlign: "center", vAlign: "middle", lineClamp: 2 }),
      obj({ type: "transcript-strip", mode: "latest" }, 0.08, 0.86, 0.84, 0.09,
        { fontSize: 0.038, color: "rgba(255,255,255,0.85)", textAlign: "center", vAlign: "middle" }),
    ],
  };
}

export class StageController {
  private state: StageState = {
    serviceTypeId: null,
    serviceTypeName: null,
    planMode: "auto",
    planId: null,
    planTitle: null,
    planSeriesTitle: null,
    views: [{ id: PRIMARY_DISPLAY_ID, name: "Slots", kind: "slots", ndiSource: null, createdAt: "" }],
    outputs: [{ id: PRIMARY_DISPLAY_ID, name: "Display 1", viewId: PRIMARY_DISPLAY_ID }],
    slotsByView: {},
    slotsByLayoutObject: {},
    resolvedByOutput: {},
    chargerBays: [],
    slots: [],
    slotsByDisplay: {},
    displays: [{ id: PRIMARY_DISPLAY_ID, name: "Display 1", kind: "slots", ndiSource: null }],
    pcoConfigured: false,
    lastRefreshedAt: null,
    remoteUrl: null,
    lanUrl: null,
    showQr: true,
    allowedServiceTypeIds: ["41227", "61695", "75953", "249176"],
    appName: "Stage Utility",
    appLogo: null,
    appLogoMonochrome: true,
    emptySlotLogo: null,
    defaultAvatar: null,
    ndiEnabled: false,
    publicUrl: null,
    captionChannelColors: {},
    autoUpdate: { enabled: false, dayOfWeek: null, hour: 3 },
    onboardingDismissed: false,
  };

  // Live device statuses keyed by channelId.
  private deviceStatuses = new Map<string, DeviceStatus>();
  // Wireless connection display names keyed by connectionId — used to label
  // charger bays by the user's connection name instead of an arbitrary index.
  private connectionNames = new Map<string, string>();
  // Coalesce timer for device-status updates (see applyDeviceStatus).
  private deviceStatusFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private deviceStatusDirty = false; // device status changed while no client watched
  // Cached team members for the active plan.
  private teamMembers: TeamMemberDTO[] = [];
  // Raw (un-resolved) slot configs per VIEW id for the ACTIVE service type.
  private rawSlotsByView = new Map<string, Slot[]>();
  // Raw (unresolved) slots for inline mic-slots objects, keyed by layout object id,
  // for the active service type. Resolved into state.slotsByLayoutObject.
  private rawSlotsByObject = new Map<string, Slot[]>();

  // PCO credentials (set by IntegrationManager after config saves).
  private pcoAppId: string | null = null;
  private pcoCountdownTarget: "plan-start" | "service-time" = "plan-start";
  private pcoSecret: string | null = null;

  // Latest PCO live state (set by fetchLive) — used by the auto-update guard.
  private lastLive: PcoLiveDTO | null = null;
  // Hourly self-update availability check (+ scheduled auto-apply).
  private updateCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Hourly auto-refresh of the active plan.
  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private isRefreshing = false;

  // ── Init ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    console.log("[stage-controller] init");
    const settings = await settingsStore.load();

    const showQr = settings.showQr ?? true;

    const { views, outputs } = await this.loadOrMigrateViewsAndOutputs(settings);

    const allowedServiceTypeIds: string[] =
      Array.isArray(settings.allowedServiceTypeIds) && settings.allowedServiceTypeIds.length > 0
        ? settings.allowedServiceTypeIds
        : ["41227", "61695", "75953", "249176"];

    this.state = {
      ...this.state,
      serviceTypeId: settings.serviceTypeId,
      serviceTypeName: settings.serviceTypeName,
      planMode: settings.planMode,
      planId: settings.planId,
      planTitle: settings.planTitle,
      planSeriesTitle: settings.planSeriesTitle ?? null,
      views,
      outputs,
      showQr,
      allowedServiceTypeIds,
      appName: settings.appName ?? "Stage Utility",
      appLogo: settings.appLogo ?? null,
      appLogoMonochrome: settings.appLogoMonochrome ?? true,
      emptySlotLogo: settings.emptySlotLogo ?? null,
      defaultAvatar: settings.defaultAvatar ?? null,
      ndiEnabled: settings.ndiEnabled ?? false,
      publicUrl: settings.publicUrl ?? null,
      captionChannelColors: settings.captionChannelColors ?? {},
      autoUpdate: settings.autoUpdate ?? { enabled: false, dayOfWeek: null, hour: 3 },
      onboardingDismissed: settings.onboardingDismissed ?? false,
    };
    this.publicUrl = settings.publicUrl ?? null;
    this.applyRemoteUrl();
    this.startUpdateChecks();

    await this.loadAllViewRawSlots(settings.serviceTypeId);
    this.recomputeResolved();

    console.log("[stage-controller] loaded settings", {
      serviceTypeId: this.state.serviceTypeId,
      planId: this.state.planId,
      planMode: this.state.planMode,
      showQr: this.state.showQr,
      views: views.length,
      outputs: outputs.length,
      allowedServiceTypeIds: this.state.allowedServiceTypeIds,
    });
  }

  /**
   * Load Views + Outputs, migrating the legacy per-display model on first run.
   * Idempotent: once `settings.outputs` exists, the migration is skipped.
   *
   * Migration maps each legacy DisplayInfo 1:1 to a View (id = display.id, so the
   * View reuses the display's existing slots.json bucket with no rewrite) and an
   * Output (id = display.id, so every existing kiosk URL keeps resolving), routed
   * to that View. Nothing on the wall changes.
   */
  private async loadOrMigrateViewsAndOutputs(
    settings: Awaited<ReturnType<typeof settingsStore.load>>,
  ): Promise<{ views: View[]; outputs: Output[] }> {
    const storedViews = await viewsStore.load();
    const storedOutputs = settings.outputs;

    if (storedOutputs && storedOutputs.length > 0 && storedViews.length > 0) {
      return { views: storedViews, outputs: storedOutputs };
    }

    // First run: migrate from the legacy `displays` array (or the default).
    const legacy: DisplayInfo[] =
      settings.displays && settings.displays.length > 0
        ? settings.displays
        : [{ id: PRIMARY_DISPLAY_ID, name: "Display 1", kind: "slots" }];

    const now = new Date().toISOString();
    const views: View[] = legacy.map((d) => ({
      id: d.id,
      name: d.name,
      kind: (d.kind ?? "slots") as ViewKind,
      ndiSource: d.ndiSource ?? null,
      createdAt: now,
    }));
    const outputs: Output[] = legacy.map((d) => ({
      id: d.id,
      name: d.name,
      viewId: d.id,
    }));

    await viewsStore.save(views);
    await settingsStore.patch({ outputs });
    console.log(
      `[stage-controller] migrated ${legacy.length} legacy display(s) → ${views.length} view(s) + ${outputs.length} output(s)`,
    );
    return { views, outputs };
  }

  // ── PCO credentials ───────────────────────────────────────────────────

  setPcoCredentials(appId: string | null, secret: string | null, countdownTarget?: "plan-start" | "service-time"): void {
    this.pcoAppId = appId;
    this.pcoSecret = secret;
    if (countdownTarget) this.pcoCountdownTarget = countdownTarget;
    this.state = { ...this.state, pcoConfigured: !!(appId && secret) };
    // No broadcast here — called as part of IntegrationManager's setConfig which broadcasts separately.
  }

  // ── Remote URL ────────────────────────────────────────────────────────
  // The connect QR + display links use `remoteUrl`. It's the configured public
  // URL (DNS) when set, otherwise the auto-detected LAN address.

  private lanUrl: string | null = null;
  private publicUrl: string | null = null;

  /** Called by the server at startup with the auto-detected LAN address. */
  setRemoteUrl(url: string | null): void {
    this.lanUrl = url;
    this.applyRemoteUrl();
  }

  /** Set (or clear with null) the public base URL — persisted + broadcast. */
  async setPublicUrl(url: string | null): Promise<StageState> {
    const normalized = normalizeBaseUrl(url);
    console.log(`[stage-controller] setPublicUrl → ${normalized ?? "(cleared)"}`);
    this.publicUrl = normalized;
    this.state = { ...this.state, publicUrl: normalized };
    await settingsStore.patch({ publicUrl: normalized });
    this.applyRemoteUrl();
    this.broadcast();
    return this.state;
  }

  private applyRemoteUrl(): void {
    // `remoteUrl` prefers the public DNS URL (for the connect QR / display links).
    // `lanUrl` is always the raw LAN IP address — Bitfocus Companion can't resolve
    // DNS, so its panel uses this regardless of any configured public URL.
    this.state = { ...this.state, remoteUrl: this.publicUrl || this.lanUrl, lanUrl: this.lanUrl };
  }

  // ── Public state ──────────────────────────────────────────────────────

  getState(): StageState {
    return { ...this.state };
  }

  getDisplays(): DisplayInfo[] {
    return [...this.state.displays];
  }

  // ── Service type ──────────────────────────────────────────────────────

  async listServiceTypes(): Promise<ServiceTypeDTO[]> {
    this.assertPco();
    return pcoService.listServiceTypes(this.pcoAppId!, this.pcoSecret!);
  }

  async setServiceType(id: string): Promise<StageState> {
    this.assertPco();
    const types = await pcoService.listServiceTypes(this.pcoAppId!, this.pcoSecret!);
    const found = types.find((t) => t.id === id);
    if (!found) throw new Error(`Service type ${id} not found`);

    console.log(`[stage-controller] setServiceType → ${id} (${found.name})`);

    this.state = {
      ...this.state,
      serviceTypeId: id,
      serviceTypeName: found.name,
      planId: null,
      planTitle: null,
      planSeriesTitle: null,
    };
    this.teamMembers = [];

    // Reload raw slots for every view with the new service type.
    await this.loadAllViewRawSlots(id);

    await settingsStore.patch({
      serviceTypeId: id,
      serviceTypeName: found.name,
      planId: null,
      planTitle: null,
      planSeriesTitle: null,
    });

    if (this.state.planMode === "auto") {
      await this.selectNextPlan();
      return this.state;
    }

    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }

  // ── Plans ──────────────────────────────────────────────────────────────

  async listPlans(serviceTypeId: string): Promise<PlanDTO[]> {
    this.assertPco();
    return pcoService.listUpcomingPlans(this.pcoAppId!, this.pcoSecret!, serviceTypeId);
  }

  async listTeamPositions(): Promise<TeamPositionDTO[]> {
    this.assertPco();
    if (!this.state.serviceTypeId) return [];
    return pcoService.listTeamPositions(this.pcoAppId!, this.pcoSecret!, this.state.serviceTypeId);
  }

  /**
   * Fetch the PCO Services Live countdown for the active plan. Returns null when
   * PCO isn't configured or no plan/service-type is selected (nothing to poll).
   * Used by the live poller; never throws for the not-configured case.
   */
  async fetchLive(): Promise<PcoLiveDTO | null> {
    if (!this.pcoAppId || !this.pcoSecret) {
      this.lastLive = null;
      return null;
    }
    if (!this.state.serviceTypeId || !this.state.planId) {
      this.lastLive = null;
      return null;
    }
    const live = await pcoService.getLive(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId,
      this.state.planId,
      this.pcoCountdownTarget,
    );
    // Remembered for the auto-update guard (don't update mid-service).
    this.lastLive = live;
    return live;
  }

  /** True when a PCO Services Live session is running (used to defer auto-updates). */
  isServiceLive(): boolean {
    return this.lastLive != null && this.lastLive.mode !== "none";
  }

  /** Latest PCO live snapshot (null if none fetched yet) — for the update-lock guard. */
  getLastLive(): PcoLiveDTO | null {
    return this.lastLive;
  }

  /**
   * Advance / rewind the PCO Services Live timer (same as PCO's own next/previous
   * item controls). Throws when PCO isn't configured, no plan is selected, or PCO
   * rejects the action (e.g. the account isn't a live controller).
   */
  async controlLive(direction: "next" | "previous"): Promise<void> {
    if (!this.pcoAppId || !this.pcoSecret) throw new Error("Planning Center not configured");
    if (!this.state.serviceTypeId || !this.state.planId) throw new Error("No plan selected");
    await pcoService.controlLive(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId,
      this.state.planId,
      direction,
    );
  }

  // ── Plan attachments (e.g. stage plot) ──────────────────────────────────

  /** Files attached to the active plan. Empty when unconfigured / no plan. */
  async listPlanAttachments(): Promise<PcoAttachmentDTO[]> {
    if (!this.pcoAppId || !this.pcoSecret) return [];
    if (!this.state.serviceTypeId || !this.state.planId) return [];
    return pcoService.listPlanAttachments(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId,
      this.state.planId,
    );
  }

  /**
   * The active plan's full rundown (items + note-category columns) for the
   * ScriptViewer / SPL-rundown dashboards. Empty when unconfigured / no plan.
   * `noteCategories` is the canonical column order, narrowed to those actually
   * used by at least one item.
   */
  async listCurrentPlanItems(): Promise<PlanItemsDTO> {
    const empty: PlanItemsDTO = { planId: this.state.planId, items: [], noteCategories: [] };
    if (!this.pcoAppId || !this.pcoSecret) return empty;
    if (!this.state.serviceTypeId || !this.state.planId) return empty;
    const [items, categories] = await Promise.all([
      pcoService.listPlanItems(this.pcoAppId, this.pcoSecret, this.state.serviceTypeId, this.state.planId),
      pcoService.listItemNoteCategories(this.pcoAppId, this.pcoSecret, this.state.serviceTypeId),
    ]);
    const used = new Set<string>();
    for (const it of items) for (const k of Object.keys(it.notesByCategory)) used.add(k);
    const ordered = categories.filter((c) => used.has(c));
    for (const c of used) if (!ordered.includes(c)) ordered.push(c); // any non-canonical, at end
    return { planId: this.state.planId, items, noteCategories: ordered };
  }

  // ── ScriptView (in-app ScriptViewer replacement) ────────────────────────

  async listScriptViewLayouts(): Promise<ScriptViewLayout[]> {
    return scriptViewLayoutsStore.load();
  }

  /** Bulk replace — the settings UI manages the whole array and saves it. */
  async saveScriptViewLayouts(layouts: ScriptViewLayout[]): Promise<ScriptViewLayout[]> {
    await scriptViewLayoutsStore.save(layouts);
    return layouts;
  }

  /** All note-category names PCO knows for a service type (drives the column
   *  picker). Unlike the rundown's `noteCategories`, this is NOT pruned to
   *  categories currently in use, so authors can pre-add a column. */
  async listScriptViewNoteCategories(serviceTypeId: string): Promise<string[]> {
    if (!this.pcoAppId || !this.pcoSecret || !serviceTypeId) return [];
    return pcoService.listItemNoteCategories(this.pcoAppId, this.pcoSecret, serviceTypeId);
  }

  /** Resolve the rundown for a ScriptView page. planId picks a specific plan;
   *  otherwise the live plan (when this IS the active type) or the nearest
   *  upcoming plan. `isLive` gates the live-item highlight in the renderer. */
  async getScriptViewRundown(serviceTypeId: string, planId?: string | null): Promise<ScriptViewRundownDTO> {
    const empty: ScriptViewRundownDTO = {
      serviceTypeId, planId: null, planTitle: null, planSeriesTitle: null,
      planDates: null, items: [], noteCategories: [], serviceTimes: [], isLive: false,
    };
    if (!this.pcoAppId || !this.pcoSecret || !serviceTypeId) return empty;

    const plans = await pcoService.listUpcomingPlans(this.pcoAppId, this.pcoSecret, serviceTypeId);
    const isActiveType = serviceTypeId === this.state.serviceTypeId;
    let plan: PlanDTO | null = null;
    if (planId) plan = plans.find((p) => p.id === planId) ?? null;
    else if (isActiveType && this.state.planId) plan = plans.find((p) => p.id === this.state.planId) ?? plans[0] ?? null;
    else plan = plans[0] ?? null;
    if (!plan) return empty;

    const [items, categories, serviceTimes] = await Promise.all([
      pcoService.listPlanItems(this.pcoAppId, this.pcoSecret, serviceTypeId, plan.id),
      pcoService.listItemNoteCategories(this.pcoAppId, this.pcoSecret, serviceTypeId),
      pcoService.listPlanServiceTimes(this.pcoAppId, this.pcoSecret, serviceTypeId, plan.id),
    ]);
    const used = new Set<string>();
    for (const it of items) for (const k of Object.keys(it.notesByCategory)) used.add(k);
    const ordered = categories.filter((c) => used.has(c));
    for (const c of used) if (!ordered.includes(c)) ordered.push(c);

    return {
      serviceTypeId,
      planId: plan.id,
      planTitle: plan.title,
      planSeriesTitle: plan.seriesTitle,
      planDates: plan.dates,
      items,
      noteCategories: ordered,
      serviceTimes,
      isLive: isActiveType && plan.id === this.state.planId,
    };
  }

  /**
   * Pick the active plan's attachment matching `match` (case-insensitive filename
   * substring). An empty match falls back to the first PDF, then the first file.
   * Matching by NAME (not id) is what lets a layout object track the stage plot
   * week to week — each plan gets fresh attachment ids.
   */
  async findPlanAttachment(match: string): Promise<PcoAttachmentDTO | null> {
    const list = await this.listPlanAttachments();
    if (list.length === 0) return null;
    const q = match.trim().toLowerCase();
    if (q) {
      // Match the filename OR the item it's attached to (e.g. a generically-named
      // file under an item titled "Stage Plot").
      return (
        list.find(
          (a) =>
            a.filename.toLowerCase().includes(q) || (a.sourceLabel ?? "").toLowerCase().includes(q),
        ) ?? null
      );
    }
    // Empty match → best guess: first PDF, then any image, then any non-audio file.
    const notAudio = (a: PcoAttachmentDTO) => {
      const ct = (a.contentType ?? "").toLowerCase();
      return !ct.startsWith("audio") && ct !== "application/octet-stream";
    };
    return (
      list.find((a) => (a.contentType ?? "").toLowerCase().includes("pdf")) ??
      list.find((a) => (a.contentType ?? "").toLowerCase().startsWith("image")) ??
      list.find(notAudio) ??
      null
    );
  }

  /** Temporary download link for one of the active plan's attachments. */
  async openPlanAttachment(attachmentId: string): Promise<{ url: string; contentType: string | null }> {
    if (!this.pcoAppId || !this.pcoSecret) throw new Error("Planning Center not configured");
    if (!this.state.serviceTypeId || !this.state.planId) throw new Error("No plan selected");
    return pcoService.openAttachment(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId,
      this.state.planId,
      attachmentId,
    );
  }

  /** Plan id we've already auto-advanced away from, so rollover fires once. */
  private autoAdvancedFromPlanId: string | null = null;
  /** Grace period after a plan's service end before auto-mode rolls to the next. */
  private static readonly ROLLOVER_GRACE_MS = 60 * 60 * 1000;

  /**
   * Auto mode only: once the current plan's service has ended (+1h grace), roll
   * to the globally-nearest upcoming plan. Called from the live poller. No-op in
   * manual mode, when unconfigured, or when already advanced from this plan.
   */
  async maybeAutoAdvance(): Promise<void> {
    if (this.state.planMode !== "auto") return;
    if (!this.pcoAppId || !this.pcoSecret) return;
    if (!this.state.serviceTypeId || !this.state.planId) return;
    if (this.autoAdvancedFromPlanId === this.state.planId) return;

    const endIso = await pcoService
      .getServiceEnd(this.pcoAppId, this.pcoSecret, this.state.serviceTypeId, this.state.planId)
      .catch(() => null);
    if (!endIso) return;
    const end = Date.parse(endIso);
    if (!Number.isFinite(end)) return;
    if (Date.now() < end + StageController.ROLLOVER_GRACE_MS) return;

    console.log(
      `[stage-controller] auto rollover — plan ${this.state.planId} ended >1h ago, selecting next`,
    );
    this.autoAdvancedFromPlanId = this.state.planId;
    await this.selectGlobalNextPlan().catch((err) =>
      console.error("[stage-controller] auto rollover error:", err),
    );
  }

  async setPlan(id: string): Promise<StageState> {
    this.assertPco();
    if (!this.state.serviceTypeId) throw new Error("No service type selected");
    const plans = await pcoService.listUpcomingPlans(
      this.pcoAppId!,
      this.pcoSecret!,
      this.state.serviceTypeId,
    );
    const found = plans.find((p) => p.id === id);
    if (!found) throw new Error(`Plan ${id} not found`);

    console.log(`[stage-controller] setPlan → ${id} (${found.title})`);
    await this.applyPlan(found);
    return this.state;
  }

  async selectNextPlan(): Promise<StageState> {
    this.assertPco();
    if (!this.state.serviceTypeId) throw new Error("No service type selected");

    const plans = await pcoService.listUpcomingPlans(
      this.pcoAppId!,
      this.pcoSecret!,
      this.state.serviceTypeId,
    );

    if (plans.length === 0) {
      console.log("[stage-controller] selectNextPlan: no upcoming plans");
      this.state = { ...this.state, planId: null, planTitle: null, planSeriesTitle: null };
      this.teamMembers = [];
      await settingsStore.patch({ planId: null, planTitle: null, planSeriesTitle: null });
      await this.reResolveAll();
      this.broadcast();
      return this.state;
    }

    // Advance RELATIVE to the current plan, not just plans[0]. PCO's filter=future
    // keeps today's (already-selected) plan in the list, so picking plans[0] left
    // "Next plan" stuck on the current plan. Find the current plan and step to the
    // one after it; if it isn't in the upcoming list (it's already past), jump to
    // the nearest upcoming.
    const idx = this.state.planId ? plans.findIndex((p) => p.id === this.state.planId) : -1;
    const next = idx >= 0 ? plans[idx + 1] : plans[0];
    if (!next) {
      console.log("[stage-controller] selectNextPlan: already at the last upcoming plan");
      return this.state;
    }
    console.log(`[stage-controller] selectNextPlan → ${next.id} (${next.title})`);
    await this.applyPlan(next);
    return this.state;
  }

  /**
   * Cross-service-type auto-follow: finds the nearest upcoming plan across all
   * allowed service types and switches to it. Empty allowedServiceTypeIds = all
   * service types are candidates.
   */
  async selectGlobalNextPlan(): Promise<StageState> {
    this.assertPco();
    console.log("[stage-controller] selectGlobalNextPlan — scanning allowed service types");

    const allTypes = await pcoService.listServiceTypes(this.pcoAppId!, this.pcoSecret!);
    const allowed = this.state.allowedServiceTypeIds;
    const candidates =
      allowed.length === 0
        ? allTypes
        : allTypes.filter((t) => allowed.includes(t.id));

    console.log(
      `[stage-controller] selectGlobalNextPlan — ${candidates.length} candidate types: ${candidates.map((c) => c.id).join(", ")}`,
    );

    // For each candidate, fetch its nearest upcoming plan.
    type Candidate = { type: ServiceTypeDTO; plan: PlanDTO };
    let best: Candidate | null = null;

    for (const type of candidates) {
      try {
        const plans = await pcoService.listUpcomingPlans(this.pcoAppId!, this.pcoSecret!, type.id);
        if (plans.length === 0) continue;

        // PCO's `filter=future` keeps a plan in the list for the WHOLE service day,
        // even after its service has already ended — so `plans[0]` is frequently the
        // plan that just finished this morning. Walk past any plan whose service
        // ended more than the grace window ago and take the first still-upcoming one.
        // Without this, auto-mode "advances" right back onto the finished plan (its
        // sort_date is the earliest in `future`) and never reaches the real next one.
        // Resolve every candidate plan's service end concurrently (each is a
        // cached /plan_times lookup) instead of awaiting them one-by-one.
        const ends = await Promise.all(
          plans.map((p) =>
            pcoService.getServiceEnd(this.pcoAppId!, this.pcoSecret!, type.id, p.id).catch(() => null),
          ),
        );
        let nearest: PlanDTO | null = null;
        for (let i = 0; i < plans.length; i++) {
          const endIso = ends[i];
          if (endIso) {
            const end = Date.parse(endIso);
            if (Number.isFinite(end) && Date.now() > end + StageController.ROLLOVER_GRACE_MS) {
              continue; // finished plan still lingering in filter=future — skip it
            }
          }
          nearest = plans[i]; // service still upcoming / within grace, or end unknown
          break;
        }
        if (!nearest) continue; // every future plan for this type has already ended

        if (
          best === null ||
          (nearest.sortDate !== null &&
            (best.plan.sortDate === null || nearest.sortDate < best.plan.sortDate))
        ) {
          best = { type, plan: nearest };
        }
      } catch (err) {
        console.error(`[stage-controller] selectGlobalNextPlan — error fetching plans for type ${type.id}:`, err);
      }
    }

    if (!best) {
      // No candidate has any upcoming plans — clear plan, keep service type or set null.
      console.log("[stage-controller] selectGlobalNextPlan — no upcoming plans found across all candidates");
      this.state = {
        ...this.state,
        planId: null,
        planTitle: null,
        planSeriesTitle: null,
        lastRefreshedAt: new Date().toISOString(),
      };
      this.teamMembers = [];
      await settingsStore.patch({ planId: null, planTitle: null, planSeriesTitle: null });
      await this.reResolveAll();
      this.broadcast();
      return this.state;
    }

    console.log(
      `[stage-controller] selectGlobalNextPlan → type=${best.type.id} (${best.type.name}) plan=${best.plan.id} (${best.plan.title}) sortDate=${best.plan.sortDate}`,
    );

    // Switch service type if needed and reload display slots.
    if (this.state.serviceTypeId !== best.type.id) {
      this.state = {
        ...this.state,
        serviceTypeId: best.type.id,
        serviceTypeName: best.type.name,
        planId: null,
        planTitle: null,
        planSeriesTitle: null,
      };
      this.teamMembers = [];
      await this.loadAllViewRawSlots(best.type.id);
      await settingsStore.patch({
        serviceTypeId: best.type.id,
        serviceTypeName: best.type.name,
      });
    }

    await this.applyPlan(best.plan);
    return this.state;
  }

  async setAllowedServiceTypes(ids: string[]): Promise<StageState> {
    console.log(`[stage-controller] setAllowedServiceTypes → [${ids.join(", ")}]`);
    this.state = { ...this.state, allowedServiceTypeIds: ids };
    await settingsStore.patch({ allowedServiceTypeIds: ids });
    broadcast("settings:allowedServiceTypeIds-changed", { value: ids });

    if (this.state.planMode === "auto") {
      await this.selectGlobalNextPlan();
      return this.state;
    }

    this.broadcast();
    return this.state;
  }

  async setPlanMode(mode: "auto" | "manual"): Promise<StageState> {
    console.log(`[stage-controller] setPlanMode → ${mode}`);
    this.state = { ...this.state, planMode: mode };
    await settingsStore.patch({ planMode: mode });

    if (mode === "auto") {
      await this.selectGlobalNextPlan();
      return this.state;
    }

    this.broadcast();
    return this.state;
  }

  // ── Slots ─────────────────────────────────────────────────────────────

  /** Legacy alias — `target` is an output id (or empty for primary); routes to
   *  that output's View. Kept for the /api/slots endpoint + phone control page. */
  /** Resolve raw draft slots against the current team + device state WITHOUT
   *  persisting or broadcasting. Powers the Views page live draft preview: the
   *  settings UI resolves in-progress (unsaved) edits so the preview matches what
   *  the kiosk would show, exactly as recomputeResolved() does for saved slots. */
  resolveSlotsPreview(slots: Slot[]): Slot[] {
    return resolveSlots(slots, this.teamMembers, this.deviceStatuses);
  }

  async setSlots(target: string, slots: Slot[]): Promise<StageState> {
    return this.setViewSlots(this.viewIdForTarget(target), slots);
  }

  /** Persist + apply a slots-kind View's slot configuration for the active
   *  service type, then re-resolve and broadcast. */
  async setViewSlots(viewId: string, slots: Slot[]): Promise<StageState> {
    if (!this.state.serviceTypeId) {
      console.log("[stage-controller] setViewSlots: no active service type — slots not persisted");
    } else {
      console.log(`[stage-controller] setViewSlots (${slots.length} slots) for view=${viewId} serviceType=${this.state.serviceTypeId}`);
      await slotsStore.setSlots(viewId, this.state.serviceTypeId, slots);
    }
    this.rawSlotsByView.set(viewId, slots);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Persist + apply an inline mic-slots object's slot configuration (a custom
   *  layout `slots-grid` with source "inline") for the active service type, keyed
   *  by the layout object's id, then re-resolve and broadcast. */
  async setLayoutObjectSlots(objectId: string, slots: Slot[]): Promise<StageState> {
    if (!this.state.serviceTypeId) {
      console.log("[stage-controller] setLayoutObjectSlots: no active service type — slots not persisted");
    } else {
      console.log(`[stage-controller] setLayoutObjectSlots (${slots.length} slots) for object=${objectId} serviceType=${this.state.serviceTypeId}`);
      await slotsStore.setSlots(objectId, this.state.serviceTypeId, slots);
    }
    this.rawSlotsByObject.set(objectId, slots);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  // ── QR visibility ─────────────────────────────────────────────────────

  async setShowQr(show: boolean): Promise<StageState> {
    console.log(`[stage-controller] setShowQr → ${show}`);
    this.state = { ...this.state, showQr: show };
    await settingsStore.patch({ showQr: show });
    this.broadcast();
    return this.state;
  }

  /** Dismiss (or restore) the first-run "Getting started" checklist, machine-wide. */
  async setOnboardingDismissed(dismissed: boolean): Promise<StageState> {
    this.state = { ...this.state, onboardingDismissed: dismissed };
    await settingsStore.patch({ onboardingDismissed: dismissed });
    this.broadcast();
    return this.state;
  }

  // ── NDI visibility ────────────────────────────────────────────────────

  async setNdiEnabled(enabled: boolean): Promise<StageState> {
    console.log(`[stage-controller] setNdiEnabled → ${enabled}`);
    this.state = { ...this.state, ndiEnabled: enabled };
    await settingsStore.patch({ ndiEnabled: enabled });
    this.broadcast();
    return this.state;
  }

  // ── Remote refresh ────────────────────────────────────────────────────

  /** Tell kiosk pages to reload so they pick up new content. `target` is an
   *  output id, or "all" (empty) to reload every connected display. Pushes a
   *  one-off SSE event — no state change. */
  refreshDisplays(target: string): void {
    const t = target || "all";
    console.log(`[stage-controller] refreshDisplays → ${t}`);
    broadcast("display:refresh", { target: t });
  }

  // ── Self-update (auto-update schedule) ────────────────────────────────

  async setAutoUpdate(partial: Partial<AutoUpdateSettings>): Promise<StageState> {
    const next: AutoUpdateSettings = { ...this.state.autoUpdate, ...partial };
    // Clamp hour to 0–23; dayOfWeek to 0–6 or null.
    next.hour = Math.min(23, Math.max(0, Math.round(next.hour)));
    next.dayOfWeek =
      next.dayOfWeek == null ? null : Math.min(6, Math.max(0, Math.round(next.dayOfWeek)));
    console.log(`[stage-controller] setAutoUpdate →`, next);
    this.state = { ...this.state, autoUpdate: next };
    await settingsStore.patch({ autoUpdate: next });
    this.broadcast();
    return this.state;
  }

  /** Start the hourly update-availability check + scheduled auto-apply. */
  private startUpdateChecks(): void {
    if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);
    // Initial check shortly after boot, then hourly.
    setTimeout(() => void this.updateCheckTick(), 3_000);
    this.updateCheckTimer = setInterval(() => void this.updateCheckTick(), 60 * 60 * 1000);
  }

  stopUpdateChecks(): void {
    if (this.updateCheckTimer) {
      clearInterval(this.updateCheckTimer);
      this.updateCheckTimer = null;
    }
  }

  private async updateCheckTick(): Promise<void> {
    try {
      const status = await updater.checkForUpdate();
      if (this.shouldAutoApply(status.behind, new Date())) {
        console.log("[stage-controller] auto-update window — applying update");
        await updater.applyUpdate();
      }
    } catch (err) {
      console.error("[stage-controller] update check failed:", err);
    }
  }

  /** Auto-apply gate: enabled + something to pull + inside the scheduled
   *  day/hour window + not mid-service. Exposed for unit testing. */
  shouldAutoApply(behind: number, now: Date): boolean {
    const cfg = this.state.autoUpdate;
    if (!cfg.enabled || behind <= 0) return false;
    if (updater.phase === "updating") return false;
    if (this.isServiceLive()) return false;
    if (cfg.dayOfWeek != null && now.getDay() !== cfg.dayOfWeek) return false;
    return now.getHours() === cfg.hour;
  }

  // ── Branding (app name + logo) ────────────────────────────────────────

  /** Update branding. Any field may be omitted to leave it unchanged; pass
   *  `logo: null` to clear the logo. The original image + crop transform are
   *  persisted to settings only (not broadcast) so the editor can retain zoom. */
  async setBranding(partial: {
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
  }): Promise<StageState> {
    // Fields that live in both the broadcast state and settings.
    const stateNext: Partial<Pick<StageState, "appName" | "appLogo" | "appLogoMonochrome" | "emptySlotLogo" | "defaultAvatar">> = {};
    if (typeof partial.name === "string") stateNext.appName = partial.name.trim() || "Stage Utility";
    if (partial.logo !== undefined) stateNext.appLogo = partial.logo;
    if (typeof partial.monochrome === "boolean") stateNext.appLogoMonochrome = partial.monochrome;
    if (partial.emptyLogo !== undefined) stateNext.emptySlotLogo = partial.emptyLogo;
    if (partial.avatar !== undefined) stateNext.defaultAvatar = partial.avatar;

    // Settings-only fields (originals + crops), never broadcast.
    const settingsNext: Record<string, unknown> = { ...stateNext };
    if (partial.logoOriginal !== undefined) settingsNext.appLogoOriginal = partial.logoOriginal;
    if (partial.logoCrop !== undefined) settingsNext.appLogoCrop = partial.logoCrop;
    if (partial.emptyLogoOriginal !== undefined) settingsNext.emptySlotLogoOriginal = partial.emptyLogoOriginal;
    if (partial.emptyLogoCrop !== undefined) settingsNext.emptySlotLogoCrop = partial.emptyLogoCrop;
    if (partial.avatarOriginal !== undefined) settingsNext.defaultAvatarOriginal = partial.avatarOriginal;
    if (partial.avatarCrop !== undefined) settingsNext.defaultAvatarCrop = partial.avatarCrop;
    // Clearing an image also clears its editing source.
    if (partial.logo === null) {
      settingsNext.appLogoOriginal = null;
      settingsNext.appLogoCrop = null;
    }
    if (partial.emptyLogo === null) {
      settingsNext.emptySlotLogoOriginal = null;
      settingsNext.emptySlotLogoCrop = null;
    }
    if (partial.avatar === null) {
      settingsNext.defaultAvatarOriginal = null;
      settingsNext.defaultAvatarCrop = null;
    }

    console.log(`[stage-controller] setBranding`, {
      name: stateNext.appName,
      logo: partial.logo === undefined ? "(unchanged)" : partial.logo ? "(set)" : "(cleared)",
      monochrome: stateNext.appLogoMonochrome,
      emptyLogo: partial.emptyLogo === undefined ? "(unchanged)" : partial.emptyLogo ? "(set)" : "(cleared)",
      avatar: partial.avatar === undefined ? "(unchanged)" : partial.avatar ? "(set)" : "(cleared)",
    });
    this.state = { ...this.state, ...stateNext };
    await settingsStore.patch(settingsNext);
    this.broadcast();
    return this.state;
  }

  /** Set (or clear, with color=null) a user-assigned caption color for a ProdCom
   *  channel label. Persisted + broadcast so kiosks recolor live. */
  async setCaptionChannelColor(channel: string, color: string | null): Promise<StageState> {
    const key = channel.trim();
    if (!key) return this.state;
    const next = { ...this.state.captionChannelColors };
    if (color && /^#?[0-9a-f]{3,8}$/i.test(color.trim())) {
      const c = color.trim();
      next[key] = c.startsWith("#") ? c : `#${c}`;
    } else {
      delete next[key]; // null/invalid → revert to auto
    }
    this.state = { ...this.state, captionChannelColors: next };
    await settingsStore.patch({ captionChannelColors: next });
    this.broadcast();
    return this.state;
  }

  /** Original upload + saved crop transform for a brand image, for re-editing. */
  async getBrandingSource(target: "app" | "empty" | "avatar" = "app"): Promise<{
    original: string | null;
    crop: { scale: number; x: number; y: number } | null;
  }> {
    const settings = await settingsStore.load();
    if (target === "empty") {
      return {
        original: settings.emptySlotLogoOriginal ?? null,
        crop: settings.emptySlotLogoCrop ?? null,
      };
    }
    if (target === "avatar") {
      return {
        original: settings.defaultAvatarOriginal ?? null,
        crop: settings.defaultAvatarCrop ?? null,
      };
    }
    return { original: settings.appLogoOriginal ?? null, crop: settings.appLogoCrop ?? null };
  }

  // ── Presets ───────────────────────────────────────────────────────────

  async listPresets(): Promise<SlotPreset[]> {
    return presetsStore.load();
  }

  async savePreset(target: string, name: string): Promise<SlotPreset[]> {
    const viewId = this.viewIdForTarget(target);
    console.log(`[stage-controller] savePreset "${name}" for view=${viewId}`);
    const presets = await presetsStore.load();
    const rawSlots = this.rawSlotsByView.get(viewId) ?? [];
    const newPreset: SlotPreset = {
      id: randomUUID(),
      name,
      // Deep-clone with fresh slot ids so preset slots are independent.
      slots: rawSlots.map((s) => ({ ...s, id: randomUUID() })),
      createdAt: new Date().toISOString(),
    };
    const updated = [...presets, newPreset];
    await presetsStore.save(updated);
    return updated;
  }

  async applyPreset(target: string, id: string): Promise<StageState> {
    const viewId = this.viewIdForTarget(target);
    const presets = await presetsStore.load();
    const preset = presets.find((p) => p.id === id);
    if (!preset) throw new Error(`Preset ${id} not found`);

    console.log(`[stage-controller] applyPreset "${preset.name}" (${id}) for view=${viewId}`);

    // Deep-clone with fresh slot ids so applied slots are independent of the preset.
    const slots: Slot[] = preset.slots.map((s) => ({ ...s, id: randomUUID() }));
    return this.setViewSlots(viewId, slots);
  }

  async deletePreset(id: string): Promise<SlotPreset[]> {
    console.log(`[stage-controller] deletePreset ${id}`);
    const presets = await presetsStore.load();
    const updated = presets.filter((p) => p.id !== id);
    await presetsStore.save(updated);
    return updated;
  }

  /** Add a preset from imported data (e.g. an exported .json), with fresh ids. */
  async importPreset(name: string, slots: Slot[]): Promise<SlotPreset[]> {
    const presets = await presetsStore.load();
    const newPreset: SlotPreset = {
      id: randomUUID(),
      name: name.trim() || "Imported",
      slots: slots.map((s, i) => ({ ...s, id: randomUUID(), order: i })),
      createdAt: new Date().toISOString(),
    };
    console.log(`[stage-controller] importPreset "${newPreset.name}" (${newPreset.slots.length} slots)`);
    const updated = [...presets, newPreset];
    await presetsStore.save(updated);
    return updated;
  }

  /** Reorder the preset bank to match `orderedIds` (unknown ids ignored, missing
   *  ones appended) — mirrors reorderViews. */
  async reorderPresets(orderedIds: string[]): Promise<SlotPreset[]> {
    const presets = await presetsStore.load();
    const byId = new Map(presets.map((p) => [p.id, p]));
    const reordered: SlotPreset[] = [];
    for (const id of orderedIds) {
      const p = byId.get(id);
      if (p) {
        reordered.push(p);
        byId.delete(id);
      }
    }
    for (const p of byId.values()) reordered.push(p);
    console.log(`[stage-controller] reorderPresets → ${reordered.map((p) => p.id).join(", ")}`);
    await presetsStore.save(reordered);
    return reordered;
  }

  async renamePreset(id: string, name: string): Promise<SlotPreset[]> {
    const presets = await presetsStore.load();
    const trimmed = name.trim();
    if (!trimmed) return presets;
    console.log(`[stage-controller] renamePreset ${id} → "${trimmed}"`);
    const updated = presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
    await presetsStore.save(updated);
    return updated;
  }

  /** Replace a preset's slots with the target view's current slots (a "save over"
   *  this preset). Reuses the savePreset snapshot logic. */
  // `explicitSlots` overwrites with the given slots directly (used by inline
  // mic-slots objects, which aren't view-keyed); otherwise read the target view's.
  async overwritePreset(id: string, target: string, explicitSlots?: Slot[]): Promise<SlotPreset[]> {
    const viewId = this.viewIdForTarget(target);
    const presets = await presetsStore.load();
    if (!presets.find((p) => p.id === id)) throw new Error(`Preset ${id} not found`);
    const rawSlots = explicitSlots ?? this.rawSlotsByView.get(viewId) ?? [];
    console.log(`[stage-controller] overwritePreset ${id} (${rawSlots.length} slots)`);
    const updated = presets.map((p) =>
      p.id === id ? { ...p, slots: rawSlots.map((s) => ({ ...s, id: randomUUID() })) } : p,
    );
    await presetsStore.save(updated);
    return updated;
  }

  // ── Layout templates (reusable custom layouts) ───────────────────────

  async listLayoutTemplates(): Promise<LayoutTemplate[]> {
    return layoutTemplatesStore.load();
  }

  async saveLayoutTemplate(name: string, layout: LayoutDTO): Promise<LayoutTemplate[]> {
    const list = await layoutTemplatesStore.load();
    const tpl: LayoutTemplate = {
      id: randomUUID(),
      name: name.trim() || "Layout",
      layout: cloneLayout(layout),
      createdAt: new Date().toISOString(),
    };
    console.log(`[stage-controller] saveLayoutTemplate "${tpl.name}" (${tpl.layout.objects.length} objects)`);
    const updated = [...list, tpl];
    await layoutTemplatesStore.save(updated);
    return updated;
  }

  async updateLayoutTemplate(id: string, patch: { name?: string; layout?: LayoutDTO }): Promise<LayoutTemplate[]> {
    const list = await layoutTemplatesStore.load();
    if (!list.find((t) => t.id === id)) throw new Error(`layout template ${id} not found`);
    const updated = list.map((t) =>
      t.id === id
        ? {
            ...t,
            name: patch.name !== undefined ? (patch.name.trim() || t.name) : t.name,
            layout: patch.layout ? cloneLayout(patch.layout) : t.layout,
          }
        : t,
    );
    console.log(`[stage-controller] updateLayoutTemplate ${id}`);
    await layoutTemplatesStore.save(updated);
    return updated;
  }

  async deleteLayoutTemplate(id: string): Promise<LayoutTemplate[]> {
    console.log(`[stage-controller] deleteLayoutTemplate ${id}`);
    const list = await layoutTemplatesStore.load();
    const updated = list.filter((t) => t.id !== id);
    await layoutTemplatesStore.save(updated);
    return updated;
  }

  // ── Layout groups (reusable object/container library) ───────────────────
  // Like templates, but a single object subtree the operator inserts into a view
  // rather than a whole-layout replace. (Inline mic-slot data is per-object/
  // per-service-type and is NOT carried — same as templates; re-pick slots after.)

  async listLayoutGroups(): Promise<LayoutGroup[]> {
    return layoutGroupsStore.load();
  }

  async saveLayoutGroup(name: string, object: LayoutObject): Promise<LayoutGroup[]> {
    const list = await layoutGroupsStore.load();
    const group: LayoutGroup = {
      id: randomUUID(),
      name: name.trim() || "Group",
      object: cloneLayoutObject(object), // fresh ids so the library copy is isolated
      createdAt: new Date().toISOString(),
    };
    console.log(`[stage-controller] saveLayoutGroup "${group.name}" (${(group.object.children?.length ?? 0)} children)`);
    const updated = [...list, group];
    await layoutGroupsStore.save(updated);
    return updated;
  }

  async deleteLayoutGroup(id: string): Promise<LayoutGroup[]> {
    console.log(`[stage-controller] deleteLayoutGroup ${id}`);
    const list = await layoutGroupsStore.load();
    const updated = list.filter((g) => g.id !== id);
    await layoutGroupsStore.save(updated);
    return updated;
  }

  // ── Views (content) ─────────────────────────────────────────────────

  getViews(): View[] {
    return [...this.state.views];
  }

  async createView(name: string, kind: ViewKind = "slots"): Promise<StageState> {
    const id = this.nextViewId();
    const view: View = {
      id,
      name: name?.trim() || defaultViewName(kind),
      kind,
      ndiSource: null,
      createdAt: new Date().toISOString(),
      layout: kind === "custom" ? defaultCustomLayout() : null,
    };
    console.log(`[stage-controller] createView id=${id} name="${view.name}" kind=${kind}`);
    const views = [...this.state.views, view];
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    if (kind === "slots") this.rawSlotsByView.set(id, []);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  async renameView(id: string, name: string): Promise<StageState> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("views:rename — name must be non-empty");
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:rename — view ${id} not found`);
    }
    const views = this.state.views.map((v) => (v.id === id ? { ...v, name: trimmed } : v));
    console.log(`[stage-controller] renameView id=${id} name="${trimmed}"`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Change a View's kind (used by the legacy /api/displays kind alias). */
  async setViewKind(id: string, kind: ViewKind): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setKind — view ${id} not found`);
    }
    const views = this.state.views.map((v) =>
      v.id === id
        ? { ...v, kind, layout: kind === "custom" ? (v.layout ?? defaultCustomLayout()) : v.layout }
        : v,
    );
    console.log(`[stage-controller] setViewKind id=${id} kind=${kind}`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    if (kind === "slots" && !this.rawSlotsByView.has(id)) {
      const raw = this.state.serviceTypeId
        ? await slotsStore.getSlots(id, this.state.serviceTypeId)
        : [];
      this.rawSlotsByView.set(id, raw);
    }
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Assign (or clear) the NDI source a View should show. Empty → null. */
  async setViewNdiSource(id: string, source: string | null): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setNdiSource — view ${id} not found`);
    }
    const ndiSource = source?.trim() ? source.trim() : null;
    const views = this.state.views.map((v) => (v.id === id ? { ...v, ndiSource } : v));
    console.log(`[stage-controller] setViewNdiSource id=${id} source=${ndiSource ?? "(none)"}`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Set (or clear) a slots-View's physical-alignment config. */
  async setViewSlotsLayout(id: string, slotsLayout: SlotsLayout | null): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setSlotsLayout — view ${id} not found`);
    }
    const views = this.state.views.map((v) => (v.id === id ? { ...v, slotsLayout } : v));
    console.log(`[stage-controller] setViewSlotsLayout id=${id} ${slotsLayout ? `${slotsLayout.displayWidthIn}in` : "(off)"}`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Toggle the PCO Live Prev/Next controls on a "script" View. */
  async setViewShowLiveControls(id: string, showLiveControls: boolean): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setShowLiveControls — view ${id} not found`);
    }
    const views = this.state.views.map((v) => (v.id === id ? { ...v, showLiveControls } : v));
    console.log(`[stage-controller] setViewShowLiveControls id=${id} → ${showLiveControls}`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Replace a custom View's layout (visual editor save). */
  async setViewLayout(id: string, layout: LayoutDTO): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setLayout — view ${id} not found`);
    }
    const views = this.state.views.map((v) => (v.id === id ? { ...v, layout } : v));
    console.log(`[stage-controller] setViewLayout id=${id} (${layout.objects.length} objects)`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    // Load raw slots for any newly-added inline mic-slots objects, and drop the
    // in-memory entries for grids no longer present in any layout.
    const inlineIds = new Set<string>();
    forEachInlineSlotsGrid(this.state.views, (oid) => inlineIds.add(oid));
    if (this.state.serviceTypeId) {
      for (const oid of inlineIds) {
        if (!this.rawSlotsByObject.has(oid)) this.rawSlotsByObject.set(oid, await slotsStore.getSlots(oid, this.state.serviceTypeId));
      }
    }
    for (const key of [...this.rawSlotsByObject.keys()]) if (!inlineIds.has(key)) this.rawSlotsByObject.delete(key);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  async duplicateView(id: string, name?: string): Promise<StageState> {
    const src = this.state.views.find((v) => v.id === id);
    if (!src) throw new Error(`views:duplicate — view ${id} not found`);
    const newId = this.nextViewId();
    // Deep-clone the layout, recording old→new object ids so inline mic-slots can
    // be carried over to the copy.
    const cloned = src.layout ? cloneLayoutWithMap(src.layout) : null;
    const copy: View = {
      id: newId,
      name: name?.trim() || `${src.name} copy`,
      kind: src.kind,
      ndiSource: src.ndiSource ?? null,
      createdAt: new Date().toISOString(),
      layout: cloned?.layout ?? null,
    };
    console.log(`[stage-controller] duplicateView ${id} → ${newId} "${copy.name}"`);
    const views = [...this.state.views, copy];
    this.state = { ...this.state, views };
    await viewsStore.save(views);

    // Deep-copy slot config (active service type) with fresh slot ids.
    if (src.kind === "slots") {
      const srcSlots = this.rawSlotsByView.get(id) ?? [];
      const slots = srcSlots.map((s) => ({ ...s, id: randomUUID() }));
      this.rawSlotsByView.set(newId, slots);
      if (this.state.serviceTypeId) {
        await slotsStore.setSlots(newId, this.state.serviceTypeId, slots);
      }
    }
    // Copy each inline mic-slots object's slots (all service types) to the cloned
    // object ids, so the duplicated layout keeps its lineups.
    if (cloned) {
      const inlineOldIds: string[] = [];
      forEachInlineSlotsGrid([src], (oid) => inlineOldIds.push(oid));
      for (const oldId of inlineOldIds) {
        const mapped = cloned.idMap.get(oldId);
        if (!mapped) continue;
        await slotsStore.copyKey(oldId, mapped, () => randomUUID());
        if (this.state.serviceTypeId) this.rawSlotsByObject.set(mapped, await slotsStore.getSlots(mapped, this.state.serviceTypeId));
      }
    }
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Copy another View's slot config into this one (the "recall a saved
   *  arrangement" workflow, replacing presets). */
  async copyViewSlots(targetViewId: string, fromViewId: string): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === targetViewId)) {
      throw new Error(`views:copySlots — view ${targetViewId} not found`);
    }
    const src = this.rawSlotsByView.get(fromViewId) ?? [];
    const slots = src.map((s) => ({ ...s, id: randomUUID() }));
    return this.setViewSlots(targetViewId, slots);
  }

  async deleteView(id: string): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:delete — view ${id} not found`);
    }
    if (this.state.views.length <= 1) {
      throw new Error("views:delete — cannot remove the last view");
    }
    console.log(`[stage-controller] deleteView id=${id}`);
    const removed = this.state.views.find((v) => v.id === id);
    const views = this.state.views.filter((v) => v.id !== id);
    // Drop any inline mic-slots stored for this view's layout objects.
    if (removed) {
      const inlineIds: string[] = [];
      forEachInlineSlotsGrid([removed], (oid) => inlineIds.push(oid));
      for (const oid of inlineIds) {
        await slotsStore.removeDisplay(oid);
        this.rawSlotsByObject.delete(oid);
      }
    }
    // Unroute any outputs pointing at this view (render placeholder, never fail).
    const outputs = this.state.outputs.map((o) =>
      o.viewId === id ? { ...o, viewId: null } : o,
    );
    this.state = { ...this.state, views, outputs };
    await viewsStore.save(views);
    await settingsStore.patch({ outputs });
    await slotsStore.removeDisplay(id);
    this.rawSlotsByView.delete(id);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Reorder views to match the given id order (drag-and-drop). Ids not present
   *  are appended in their existing order; unknown ids are ignored. */
  async reorderViews(orderedIds: string[]): Promise<StageState> {
    const byId = new Map(this.state.views.map((v) => [v.id, v]));
    const reordered: View[] = [];
    for (const id of orderedIds) {
      const v = byId.get(id);
      if (v) {
        reordered.push(v);
        byId.delete(id);
      }
    }
    for (const v of byId.values()) reordered.push(v);
    console.log(`[stage-controller] reorderViews → ${reordered.map((v) => v.id).join(", ")}`);
    this.state = { ...this.state, views: reordered };
    await viewsStore.save(reordered);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  // ── Outputs (physical screens + routing) ─────────────────────────────

  getOutputs(): Output[] {
    return [...this.state.outputs];
  }

  async addOutput(name?: string, viewId?: string | null): Promise<StageState> {
    const id = this.nextOutputId();
    const num = parseInt(id.replace("display-", ""), 10);
    const output: Output = {
      id,
      name: name?.trim() || `Display ${Number.isFinite(num) ? num : this.state.outputs.length + 1}`,
      viewId: viewId ?? null,
    };
    console.log(`[stage-controller] addOutput id=${id} name="${output.name}" viewId=${output.viewId ?? "(none)"}`);
    const outputs = [...this.state.outputs, output];
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  async renameOutput(id: string, name: string): Promise<StageState> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("outputs:rename — name must be non-empty");
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:rename — output ${id} not found`);
    }
    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, name: trimmed } : o));
    console.log(`[stage-controller] renameOutput id=${id} name="${trimmed}"`);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Route an output to a View (or null to unroute). The recall operation. */
  async setOutputView(id: string, viewId: string | null): Promise<StageState> {
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:setView — output ${id} not found`);
    }
    if (viewId !== null && !this.state.views.find((v) => v.id === viewId)) {
      throw new Error(`outputs:setView — view ${viewId} not found`);
    }
    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, viewId } : o));
    console.log(`[stage-controller] setOutputView output=${id} → view=${viewId ?? "(none)"}`);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Toggle (or set) a full black blackout on an output, independent of its View. */
  async setOutputBlackout(id: string, blackout: boolean): Promise<StageState> {
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:setBlackout — output ${id} not found`);
    }
    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, blackout } : o));
    console.log(`[stage-controller] setOutputBlackout output=${id} → ${blackout ? "ON" : "off"}`);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Lock/unlock an output's kiosk chrome (hides the QR/settings + home logo links
   *  so a handed-out display link can't navigate away). */
  async setOutputLocked(id: string, locked: boolean): Promise<StageState> {
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:setLocked — output ${id} not found`);
    }
    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, locked } : o));
    console.log(`[stage-controller] setOutputLocked output=${id} → ${locked ? "LOCKED" : "unlocked"}`);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Reorder outputs to match the given id order (drag-and-drop). */
  async reorderOutputs(orderedIds: string[]): Promise<StageState> {
    const byId = new Map(this.state.outputs.map((o) => [o.id, o]));
    const reordered: Output[] = [];
    for (const id of orderedIds) {
      const o = byId.get(id);
      if (o) {
        reordered.push(o);
        byId.delete(id);
      }
    }
    for (const o of byId.values()) reordered.push(o);
    console.log(`[stage-controller] reorderOutputs → ${reordered.map((o) => o.id).join(", ")}`);
    this.state = { ...this.state, outputs: reordered };
    await settingsStore.patch({ outputs: reordered });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  async removeOutput(id: string): Promise<StageState> {
    if (this.state.outputs.length <= 1) {
      throw new Error("outputs:remove — cannot remove the last output");
    }
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:remove — output ${id} not found`);
    }
    console.log(`[stage-controller] removeOutput id=${id}`);
    const outputs = this.state.outputs.filter((o) => o.id !== id);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  // ── Legacy display aliases (back-compat for /api/displays + Apple app) ──
  // The old model conflated a screen and its content. Each alias maps onto the
  // new View/Output verbs so older clients keep working unchanged.

  /** @deprecated Use createView + addOutput. Creates a View of `kind` and an
   *  Output routed to it, mirroring the old "add a display" behavior. */
  async addDisplay(name?: string, kind: DisplayInfo["kind"] = "slots"): Promise<StageState> {
    const viewId = this.nextViewId();
    const outputId = this.nextOutputId();
    const num = parseInt(outputId.replace("display-", ""), 10);
    const displayName = name?.trim() || `Display ${Number.isFinite(num) ? num : this.state.outputs.length + 1}`;
    const k = (kind ?? "slots") as ViewKind;
    const view: View = { id: viewId, name: displayName, kind: k, ndiSource: null, createdAt: new Date().toISOString() };
    const output: Output = { id: outputId, name: displayName, viewId };
    console.log(`[stage-controller] addDisplay (alias) output=${outputId} view=${viewId} kind=${k}`);
    const views = [...this.state.views, view];
    const outputs = [...this.state.outputs, output];
    this.state = { ...this.state, views, outputs };
    await viewsStore.save(views);
    await settingsStore.patch({ outputs });
    if (k === "slots") this.rawSlotsByView.set(viewId, []);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** @deprecated Renames the output (the screen). */
  async renameDisplay(id: string, name: string): Promise<StageState> {
    return this.renameOutput(id, name);
  }

  /** @deprecated Sets the kind of the View routed to this output. */
  async setDisplayKind(id: string, kind: DisplayInfo["kind"]): Promise<StageState> {
    const viewId = this.outputRoutedViewId(id);
    if (!viewId) throw new Error(`displays:setKind — output ${id} has no routed view`);
    return this.setViewKind(viewId, (kind ?? "slots") as ViewKind);
  }

  /** @deprecated Sets the NDI source of the View routed to this output. */
  async setDisplayNdiSource(id: string, source: string | null): Promise<StageState> {
    const viewId = this.outputRoutedViewId(id);
    if (!viewId) throw new Error(`displays:setNdiSource — output ${id} has no routed view`);
    return this.setViewNdiSource(viewId, source);
  }

  /** @deprecated Removes the output, and its 1:1 routed View if nothing else uses it. */
  async removeDisplay(id: string): Promise<StageState> {
    const viewId = this.outputRoutedViewId(id);
    await this.removeOutput(id);
    // Clean up the routed View if it's now orphaned (migrated 1:1 case).
    if (viewId && !this.state.outputs.some((o) => o.viewId === viewId) && this.state.views.length > 1) {
      await this.deleteView(viewId);
    }
    return this.state;
  }

  // ── Refresh ───────────────────────────────────────────────────────────

  async refresh(full = true): Promise<StageState> {
    console.log(`[stage-controller] refresh (${full ? "full" : "targeted"})`);
    // Manual "Refresh now" (full) drops the whole cache for a clean re-pull. The
    // unattended periodic tick only invalidates the active plan, so static
    // metadata (service types, note categories, team positions, other plans'
    // service times) stays cached instead of being re-fetched every interval.
    if (full) pcoService.clearCache();
    else if (this.state.planId) pcoService.clearPlanCache(this.state.planId);

    if (this.state.planMode === "auto") {
      await this.selectGlobalNextPlan();
      return this.state;
    }

    if (this.state.serviceTypeId && this.state.planId) {
      await this.fetchTeamMembers(this.state.serviceTypeId, this.state.planId);
    }

    await this.reResolveAll();
    this.state = { ...this.state, lastRefreshedAt: new Date().toISOString() };
    this.broadcast();
    return this.state;
  }

  // ── Auto-refresh ───────────────────────────────────────────────────────

  startAutoRefresh(intervalMs = 60 * 60 * 1000): void {
    this.stopAutoRefresh();
    console.log(`[stage-controller] auto-refresh every ${Math.round(intervalMs / 60000)} min`);
    this.autoRefreshTimer = setInterval(() => {
      void this.autoRefreshTick();
    }, intervalMs);
  }

  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  private async autoRefreshTick(): Promise<void> {
    if (this.isRefreshing) return;
    if (!this.state.pcoConfigured || !this.state.serviceTypeId) return;
    this.isRefreshing = true;
    try {
      console.log("[stage-controller] auto-refresh tick");
      await this.refresh(false);
    } catch (err) {
      console.error("[stage-controller] auto-refresh failed:", err);
    } finally {
      this.isRefreshing = false;
    }
  }

  // ── Device status ──────────────────────────────────────────────────────

  /** Update the connectionId→name map (called when connections change), so
   *  charger bays can be labeled by the user's connection name. Recomputes so
   *  the new labels surface immediately. */
  setConnectionNames(names: Map<string, string>): void {
    this.connectionNames = names;
    this.recomputeResolved();
    this.broadcast();
  }

  applyDeviceStatus(channelId: string, status: DeviceStatus): void {
    // Store immediately so any later read sees the freshest value...
    this.deviceStatuses.set(channelId, status);
    // ...but coalesce the expensive re-resolve + full-state broadcast. Wireless
    // providers emit metering ~1/sec PER channel; doing a full recomputeResolved()
    // + broadcast() on every sample re-resolves all views and re-serialises the
    // entire state several times a second, starving the event loop (this also
    // stalled unrelated requests like switching a display's View). Debouncing onto
    // a short trailing timer keeps the RF bars visually live (sub-200ms) while
    // collapsing N-per-second-per-channel into a handful of cycles per second.
    if (this.deviceStatusFlushTimer !== null) return;
    this.deviceStatusFlushTimer = setTimeout(() => {
      this.deviceStatusFlushTimer = null;
      // Skip the expensive re-resolve + full-state broadcast when no display is
      // watching (idle). Mark dirty so the next connecting client gets fresh state
      // via ensureResolvedFresh() before hydration.
      if (channelHasSubscribers("stage:state-changed")) {
        this.recomputeResolved();
        this.broadcast();
      } else {
        this.deviceStatusDirty = true;
      }
    }, DEVICE_STATUS_FLUSH_MS);
  }

  /** Re-resolve views if device statuses changed while no client was connected, so a
   *  freshly-connecting display hydrates with current RF/battery state. Called by the
   *  SSE connect handler before sending the stage:state-changed snapshot. */
  ensureResolvedFresh(): void {
    if (!this.deviceStatusDirty) return;
    this.deviceStatusDirty = false;
    this.recomputeResolved();
  }

  /** Cancel any pending coalesced device-status broadcast (used on shutdown). */
  stopDeviceStatusUpdates(): void {
    if (this.deviceStatusFlushTimer === null) return;
    clearTimeout(this.deviceStatusFlushTimer);
    this.deviceStatusFlushTimer = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private primaryOutputId(): string {
    return this.state.outputs[0]?.id ?? PRIMARY_DISPLAY_ID;
  }

  /** The View id routed to the primary output, falling back to the first slots
   *  View (or the primary id) so legacy slot writes always land somewhere. */
  private primaryViewId(): string {
    const primary = this.state.outputs[0];
    if (primary?.viewId) return primary.viewId;
    const firstSlots = this.state.views.find((v) => v.kind === "slots");
    return firstSlots?.id ?? PRIMARY_DISPLAY_ID;
  }

  /** Resolve a legacy target (output id, empty for primary, or a raw view id)
   *  to a View id for slot writes. */
  private viewIdForTarget(target: string): string {
    if (!target) return this.primaryViewId();
    const output = this.state.outputs.find((o) => o.id === target);
    if (output) return output.viewId ?? this.primaryViewId();
    return target; // already a view id
  }

  private outputRoutedViewId(outputId: string): string | null {
    return this.state.outputs.find((o) => o.id === outputId)?.viewId ?? null;
  }

  private nextViewId(): string {
    const nums = this.state.views
      .map((v) => parseInt(v.id.replace("view-", ""), 10))
      .filter((n) => !Number.isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `view-${next}`;
  }

  private nextOutputId(): string {
    const nums = this.state.outputs
      .map((o) => parseInt(o.id.replace("display-", ""), 10))
      .filter((n) => !Number.isNaN(n));
    // display-1 is reserved as the primary/default output (PRIMARY_DISPLAY_ID), so
    // dynamically-created outputs start at display-2 when none exist yet. (Views,
    // which have no reserved id, start at view-1.)
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 2;
    return `display-${next}`;
  }

  private assertPco(): void {
    if (!this.pcoAppId || !this.pcoSecret) {
      throw new Error("PCO not configured — add App ID and Secret in Integrations settings");
    }
  }

  private async applyPlan(plan: PlanDTO): Promise<void> {
    this.state = {
      ...this.state,
      planId: plan.id,
      planTitle: plan.title,
      planSeriesTitle: plan.seriesTitle,
    };
    await settingsStore.patch({
      planId: plan.id,
      planTitle: plan.title,
      planSeriesTitle: plan.seriesTitle,
    });

    if (this.state.serviceTypeId) {
      await this.fetchTeamMembers(this.state.serviceTypeId, plan.id);
    }

    await this.reResolveAll();
    this.state = { ...this.state, lastRefreshedAt: new Date().toISOString() };
    this.broadcast();
  }

  private async fetchTeamMembers(serviceTypeId: string, planId: string): Promise<void> {
    try {
      this.teamMembers = await pcoService.listTeamMembers(
        this.pcoAppId!,
        this.pcoSecret!,
        serviceTypeId,
        planId,
      );
      console.log(`[stage-controller] fetched ${this.teamMembers.length} team members`);
    } catch (err) {
      console.error("[stage-controller] fetchTeamMembers error:", err);
      this.teamMembers = [];
    }
  }

  /** Load raw slots for every slots-kind View for the given service type. The
   *  primary View additionally adopts the legacy "default" bucket if present. */
  private async loadAllViewRawSlots(serviceTypeId: string | null): Promise<void> {
    this.rawSlotsByView.clear();
    this.rawSlotsByObject.clear();
    // Inline mic-slots objects (custom layouts) — keyed by object id.
    if (serviceTypeId) {
      const inlineIds: string[] = [];
      forEachInlineSlotsGrid(this.state.views, (oid) => inlineIds.push(oid));
      for (const oid of inlineIds) this.rawSlotsByObject.set(oid, await slotsStore.getSlots(oid, serviceTypeId));
    }
    const primaryViewId = this.primaryViewId();
    for (const view of this.state.views) {
      if (view.kind !== "slots") continue;
      if (!serviceTypeId) {
        this.rawSlotsByView.set(view.id, []);
        continue;
      }
      const slots =
        view.id === primaryViewId
          ? await slotsStore.adoptDefaultInto(view.id, serviceTypeId)
          : await slotsStore.getSlots(view.id, serviceTypeId);
      this.rawSlotsByView.set(view.id, slots);
    }
  }

  /** @deprecated Async shim kept for the many `await this.reResolveAll()` call
   *  sites; the actual work is synchronous (no I/O). */
  private async reResolveAll(): Promise<void> {
    this.recomputeResolved();
  }

  /** Resolve every slots-View, then derive the per-output descriptors and the
   *  legacy compat shim (displays/slotsByDisplay/slots) from outputs + views. */
  private recomputeResolved(): void {
    const slotsByView: Record<string, Slot[]> = {};
    for (const view of this.state.views) {
      if (view.kind !== "slots") continue;
      const raw = this.rawSlotsByView.get(view.id) ?? [];
      slotsByView[view.id] = resolveSlots(raw, this.teamMembers, this.deviceStatuses);
    }

    // Inline mic-slots objects on custom layouts — resolved by object id. We
    // resolve every object that has raw slots, not just those already saved into a
    // persisted view, so a freshly-added inline grid shows its slots immediately
    // after "Save slots" (before the layout itself is saved). Orphaned ids are
    // pruned from rawSlotsByObject when the layout is next saved (setViewLayout).
    const slotsByLayoutObject: Record<string, Slot[]> = {};
    const resolveObjectSlots = (oid: string) => {
      const raw = this.rawSlotsByObject.get(oid) ?? [];
      slotsByLayoutObject[oid] = resolveSlots(raw, this.teamMembers, this.deviceStatuses);
    };
    forEachInlineSlotsGrid(this.state.views, resolveObjectSlots);
    for (const oid of this.rawSlotsByObject.keys()) if (!(oid in slotsByLayoutObject)) resolveObjectSlots(oid);

    const resolvedByOutput: Record<string, ResolvedOutput> = {};
    const slotsByDisplay: Record<string, Slot[]> = {};
    const displays: DisplayInfo[] = [];
    for (const output of this.state.outputs) {
      const view = output.viewId ? this.state.views.find((v) => v.id === output.viewId) ?? null : null;
      const kind = view?.kind ?? "slots";
      const ndiSource = view?.ndiSource ?? null;
      resolvedByOutput[output.id] = {
        viewId: view?.id ?? null,
        kind,
        ndiSource,
        viewName: view?.name ?? null,
        blackout: output.blackout ?? false,
        locked: output.locked ?? false,
      };
      slotsByDisplay[output.id] = view && view.kind === "slots" ? (slotsByView[view.id] ?? []) : [];
      displays.push({ id: output.id, name: output.name, kind, ndiSource });
    }
    const slots = slotsByDisplay[this.primaryOutputId()] ?? [];

    this.state = {
      ...this.state,
      slotsByView,
      slotsByLayoutObject,
      resolvedByOutput,
      slotsByDisplay,
      chargerBays: this.computeChargerBays(),
      displays,
      slots,
    };
  }

  /** Derive charger battery bays from any charger-kind device statuses. The
   *  device channelId is namespaced "connectionId::bay"; chargers are indexed
   *  stably (sorted connectionId) so default bay labels stay consistent. */
  private computeChargerBays(): ChargerBayDTO[] {
    const charger = [...this.deviceStatuses.values()].filter((d) => d.deviceType === "charger");
    const connIds = [...new Set(charger.map((d) => d.channelId.split("::")[0]))].sort();
    return charger
      .map((d): ChargerBayDTO => {
        const [connectionId, bayStr] = d.channelId.split("::");
        return {
          id: d.channelId,
          connectionId: connectionId ?? d.channelId,
          bay: parseInt(bayStr ?? "0", 10) || 0,
          chargerIndex: connIds.indexOf(connectionId ?? "") + 1,
          connectionName: this.connectionNames.get(connectionId ?? "") ?? null,
          name: d.name,
          online: d.online,
          battery: d.battery,
          charging: d.charging,
          cycles: d.cycles ?? null,
          health: d.health ?? null,
          tempC: d.tempC ?? null,
        };
      })
      .sort((a, b) => a.chargerIndex - b.chargerIndex || a.bay - b.bay);
  }

  private lastBroadcastSig: string | null = null;
  private broadcast(): void {
    // Skip when nothing actually changed — a setter called with its current value
    // (same mode, unchanged settings save) still runs the mutating method. State is
    // change-driven and fires rarely, so a full-record delta protocol isn't worth its
    // client-merge risk; this dedupe removes the redundant full-state pushes cheaply.
    const sig = JSON.stringify(this.state);
    if (sig === this.lastBroadcastSig) return;
    this.lastBroadcastSig = sig;
    // Reuse the dedupe serialization as the SSE frame body so the fan-out doesn't
    // re-stringify the full state (which carries base64 branding blobs).
    broadcast("stage:state-changed", this.state, sig);
  }
}

export const stageController = new StageController();
