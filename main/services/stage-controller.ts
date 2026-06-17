// Single source of truth for all stage state.
// Every mutating method ends with broadcast("stage:state-changed").

import { randomUUID } from "crypto";

import type { DisplayInfo, LayoutDTO, LayoutTemplate, Output, PcoLiveDTO, PlanDTO, ResolvedOutput, ServiceTypeDTO, Slot, SlotPreset, StageState, TeamMemberDTO, TeamPositionDTO, View, ViewKind } from "../types/stage.js";
import type { DeviceStatus } from "../types/devices.js";
import { broadcast } from "./broadcaster.js";
import { pcoService } from "./pco-service.js";
import { presetsStore } from "./presets-store.js";
import { resolveSlots } from "./slot-resolver.js";
import { settingsStore } from "./settings-store.js";
import { slotsStore } from "./slots-store.js";
import { viewsStore } from "./views-store.js";
import { layoutTemplatesStore } from "./layout-templates-store.js";

const PRIMARY_DISPLAY_ID = "display-1";

/** Deep-clone a layout, minting fresh object ids so copies stay independent. */
function cloneLayout(l: LayoutDTO): LayoutDTO {
  return {
    version: 1,
    canvas: { ...l.canvas },
    objects: l.objects.map((o) => ({
      ...o,
      id: randomUUID(),
      style: o.style ? { ...o.style } : undefined,
      config: { ...o.config },
    })),
  };
}

function defaultViewName(kind: ViewKind): string {
  switch (kind) {
    case "dashboard": return "Dashboard";
    case "stage": return "Stage";
    case "transcription": return "Captions";
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
    resolvedByOutput: {},
    slots: [],
    slotsByDisplay: {},
    displays: [{ id: PRIMARY_DISPLAY_ID, name: "Display 1", kind: "slots", ndiSource: null }],
    pcoConfigured: false,
    lastRefreshedAt: null,
    remoteUrl: null,
    showQr: true,
    allowedServiceTypeIds: ["41227", "61695", "75953", "249176"],
    appName: "Stage Utility",
    appLogo: null,
    appLogoMonochrome: true,
    emptySlotLogo: null,
  };

  // Live device statuses keyed by channelId.
  private deviceStatuses = new Map<string, DeviceStatus>();
  // Cached team members for the active plan.
  private teamMembers: TeamMemberDTO[] = [];
  // Raw (un-resolved) slot configs per VIEW id for the ACTIVE service type.
  private rawSlotsByView = new Map<string, Slot[]>();

  // PCO credentials (set by IntegrationManager after config saves).
  private pcoAppId: string | null = null;
  private pcoSecret: string | null = null;

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
    };

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

  setPcoCredentials(appId: string | null, secret: string | null): void {
    this.pcoAppId = appId;
    this.pcoSecret = secret;
    this.state = { ...this.state, pcoConfigured: !!(appId && secret) };
    // No broadcast here — called as part of IntegrationManager's setConfig which broadcasts separately.
  }

  // ── Remote URL ────────────────────────────────────────────────────────

  setRemoteUrl(url: string | null): void {
    this.state = { ...this.state, remoteUrl: url };
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
    if (!this.pcoAppId || !this.pcoSecret) return null;
    if (!this.state.serviceTypeId || !this.state.planId) return null;
    return pcoService.getLive(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId,
      this.state.planId,
    );
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

    // Plans are ordered by sort_date asc — pick the first (nearest upcoming).
    const next = plans[0];
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
        const nearest = plans[0]; // already ordered sort_date asc
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

  // ── QR visibility ─────────────────────────────────────────────────────

  async setShowQr(show: boolean): Promise<StageState> {
    console.log(`[stage-controller] setShowQr → ${show}`);
    this.state = { ...this.state, showQr: show };
    await settingsStore.patch({ showQr: show });
    this.broadcast();
    return this.state;
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
  }): Promise<StageState> {
    // Fields that live in both the broadcast state and settings.
    const stateNext: Partial<Pick<StageState, "appName" | "appLogo" | "appLogoMonochrome" | "emptySlotLogo">> = {};
    if (typeof partial.name === "string") stateNext.appName = partial.name.trim() || "Stage Utility";
    if (partial.logo !== undefined) stateNext.appLogo = partial.logo;
    if (typeof partial.monochrome === "boolean") stateNext.appLogoMonochrome = partial.monochrome;
    if (partial.emptyLogo !== undefined) stateNext.emptySlotLogo = partial.emptyLogo;

    // Settings-only fields (originals + crops), never broadcast.
    const settingsNext: Record<string, unknown> = { ...stateNext };
    if (partial.logoOriginal !== undefined) settingsNext.appLogoOriginal = partial.logoOriginal;
    if (partial.logoCrop !== undefined) settingsNext.appLogoCrop = partial.logoCrop;
    if (partial.emptyLogoOriginal !== undefined) settingsNext.emptySlotLogoOriginal = partial.emptyLogoOriginal;
    if (partial.emptyLogoCrop !== undefined) settingsNext.emptySlotLogoCrop = partial.emptyLogoCrop;
    // Clearing an image also clears its editing source.
    if (partial.logo === null) {
      settingsNext.appLogoOriginal = null;
      settingsNext.appLogoCrop = null;
    }
    if (partial.emptyLogo === null) {
      settingsNext.emptySlotLogoOriginal = null;
      settingsNext.emptySlotLogoCrop = null;
    }

    console.log(`[stage-controller] setBranding`, {
      name: stateNext.appName,
      logo: partial.logo === undefined ? "(unchanged)" : partial.logo ? "(set)" : "(cleared)",
      monochrome: stateNext.appLogoMonochrome,
      emptyLogo: partial.emptyLogo === undefined ? "(unchanged)" : partial.emptyLogo ? "(set)" : "(cleared)",
    });
    this.state = { ...this.state, ...stateNext };
    await settingsStore.patch(settingsNext);
    this.broadcast();
    return this.state;
  }

  /** Original upload + saved crop transform for a brand image, for re-editing. */
  async getBrandingSource(target: "app" | "empty" = "app"): Promise<{
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

  /** Replace a custom View's layout (visual editor save). */
  async setViewLayout(id: string, layout: LayoutDTO): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setLayout — view ${id} not found`);
    }
    const views = this.state.views.map((v) => (v.id === id ? { ...v, layout } : v));
    console.log(`[stage-controller] setViewLayout id=${id} (${layout.objects.length} objects)`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  async duplicateView(id: string, name?: string): Promise<StageState> {
    const src = this.state.views.find((v) => v.id === id);
    if (!src) throw new Error(`views:duplicate — view ${id} not found`);
    const newId = this.nextViewId();
    const copy: View = {
      id: newId,
      name: name?.trim() || `${src.name} copy`,
      kind: src.kind,
      ndiSource: src.ndiSource ?? null,
      createdAt: new Date().toISOString(),
      // Deep-clone the layout with fresh object ids so the copy is independent.
      layout: src.layout
        ? { ...src.layout, objects: src.layout.objects.map((o) => ({ ...o, id: randomUUID() })) }
        : null,
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
    const views = this.state.views.filter((v) => v.id !== id);
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

  async refresh(): Promise<StageState> {
    console.log("[stage-controller] refresh");
    pcoService.clearCache();

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
      await this.refresh();
    } catch (err) {
      console.error("[stage-controller] auto-refresh failed:", err);
    } finally {
      this.isRefreshing = false;
    }
  }

  // ── Device status ──────────────────────────────────────────────────────

  applyDeviceStatus(channelId: string, status: DeviceStatus): void {
    this.deviceStatuses.set(channelId, status);
    // Re-resolve without clearing PCO data.
    this.recomputeResolved();
    this.broadcast();
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
      };
      slotsByDisplay[output.id] = view && view.kind === "slots" ? (slotsByView[view.id] ?? []) : [];
      displays.push({ id: output.id, name: output.name, kind, ndiSource });
    }
    const slots = slotsByDisplay[this.primaryOutputId()] ?? [];

    this.state = {
      ...this.state,
      slotsByView,
      resolvedByOutput,
      slotsByDisplay,
      displays,
      slots,
    };
  }

  private broadcast(): void {
    broadcast("stage:state-changed", this.state);
  }
}

export const stageController = new StageController();
