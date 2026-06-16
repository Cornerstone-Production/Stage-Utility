// Single source of truth for all stage state.
// Every mutating method ends with broadcast("stage:state-changed").

import { randomUUID } from "crypto";

import type { DisplayInfo, PcoLiveDTO, PlanDTO, ServiceTypeDTO, Slot, SlotPreset, StageState, TeamMemberDTO, TeamPositionDTO } from "../types/stage.js";
import type { DeviceStatus } from "../types/devices.js";
import { broadcast } from "./broadcaster.js";
import { pcoService } from "./pco-service.js";
import { presetsStore } from "./presets-store.js";
import { resolveSlots } from "./slot-resolver.js";
import { settingsStore } from "./settings-store.js";
import { slotsStore } from "./slots-store.js";

const PRIMARY_DISPLAY_ID = "display-1";

export class StageController {
  private state: StageState = {
    serviceTypeId: null,
    serviceTypeName: null,
    planMode: "auto",
    planId: null,
    planTitle: null,
    planSeriesTitle: null,
    slots: [],
    slotsByDisplay: {},
    displays: [{ id: PRIMARY_DISPLAY_ID, name: "Display 1" }],
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
  // Raw (un-resolved) slot configs per displayId for the ACTIVE service type.
  private rawSlotsByDisplay = new Map<string, Slot[]>();

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
    // Ensure at least one display is always present.
    const displays: DisplayInfo[] =
      settings.displays && settings.displays.length > 0
        ? settings.displays
        : [{ id: PRIMARY_DISPLAY_ID, name: "Display 1" }];

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
      displays,
      showQr,
      allowedServiceTypeIds,
      appName: settings.appName ?? "Stage Utility",
      appLogo: settings.appLogo ?? null,
      appLogoMonochrome: settings.appLogoMonochrome ?? true,
      emptySlotLogo: settings.emptySlotLogo ?? null,
    };

    // Load raw slots for every display.
    this.rawSlotsByDisplay.clear();
    for (const display of displays) {
      if (settings.serviceTypeId) {
        const slots =
          display.id === PRIMARY_DISPLAY_ID
            ? await slotsStore.adoptDefaultInto(display.id, settings.serviceTypeId)
            : await slotsStore.getSlots(display.id, settings.serviceTypeId);
        this.rawSlotsByDisplay.set(display.id, slots);
      } else {
        this.rawSlotsByDisplay.set(display.id, []);
      }
    }

    await this.reResolveAll();

    console.log("[stage-controller] loaded settings", {
      serviceTypeId: this.state.serviceTypeId,
      planId: this.state.planId,
      planMode: this.state.planMode,
      showQr: this.state.showQr,
      displays: displays.length,
      allowedServiceTypeIds: this.state.allowedServiceTypeIds,
    });
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

    // Reload raw slots for every display with the new service type.
    await this.loadAllDisplayRawSlots(id);

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
      await this.loadAllDisplayRawSlots(best.type.id);
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

  async setSlots(displayId: string, slots: Slot[]): Promise<StageState> {
    const effectiveDisplayId = displayId || this.primaryDisplayId();
    if (!this.state.serviceTypeId) {
      console.log("[stage-controller] setSlots: no active service type — slots not persisted");
    } else {
      console.log(`[stage-controller] setSlots (${slots.length} slots) for display=${effectiveDisplayId} serviceType=${this.state.serviceTypeId}`);
      await slotsStore.setSlots(effectiveDisplayId, this.state.serviceTypeId, slots);
    }
    this.rawSlotsByDisplay.set(effectiveDisplayId, slots);
    await this.reResolveAll();
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

  async savePreset(displayId: string, name: string): Promise<SlotPreset[]> {
    const effectiveDisplayId = displayId || this.primaryDisplayId();
    console.log(`[stage-controller] savePreset "${name}" for display=${effectiveDisplayId}`);
    const presets = await presetsStore.load();
    const rawSlots = this.rawSlotsByDisplay.get(effectiveDisplayId) ?? [];
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

  async applyPreset(displayId: string, id: string): Promise<StageState> {
    const effectiveDisplayId = displayId || this.primaryDisplayId();
    const presets = await presetsStore.load();
    const preset = presets.find((p) => p.id === id);
    if (!preset) throw new Error(`Preset ${id} not found`);

    console.log(`[stage-controller] applyPreset "${preset.name}" (${id}) for display=${effectiveDisplayId}`);

    // Deep-clone with fresh slot ids so applied slots are independent of the preset.
    const slots: Slot[] = preset.slots.map((s) => ({ ...s, id: randomUUID() }));

    if (this.state.serviceTypeId) {
      await slotsStore.setSlots(effectiveDisplayId, this.state.serviceTypeId, slots);
    }
    this.rawSlotsByDisplay.set(effectiveDisplayId, slots);
    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }

  async deletePreset(id: string): Promise<SlotPreset[]> {
    console.log(`[stage-controller] deletePreset ${id}`);
    const presets = await presetsStore.load();
    const updated = presets.filter((p) => p.id !== id);
    await presetsStore.save(updated);
    return updated;
  }

  // ── Displays ──────────────────────────────────────────────────────────

  async addDisplay(name?: string, kind: DisplayInfo["kind"] = "slots"): Promise<StageState> {
    // Sequential IDs: display-1, display-2, display-3, ...
    const existingNums = this.state.displays
      .map((d) => parseInt(d.id.replace("display-", ""), 10))
      .filter((n) => !isNaN(n));
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 2;
    const id = `display-${nextNum}`;
    const displayName = name?.trim() || `Display ${nextNum}`;
    const newDisplay: DisplayInfo = { id, name: displayName, kind };

    console.log(`[stage-controller] addDisplay id=${id} name="${displayName}" kind=${kind}`);

    const displays = [...this.state.displays, newDisplay];
    this.state = { ...this.state, displays };
    await settingsStore.patch({ displays });

    // Init empty raw slots for the new display.
    this.rawSlotsByDisplay.set(id, []);

    await this.reResolveAll();
    this.broadcast();
    return this.state;
  }

  async renameDisplay(id: string, name: string): Promise<StageState> {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("displays:rename — name must be non-empty");
    const displays = this.state.displays.map((d) =>
      d.id === id ? { ...d, name: trimmedName } : d,
    );
    if (!displays.find((d) => d.id === id)) {
      throw new Error(`displays:rename — display ${id} not found`);
    }
    console.log(`[stage-controller] renameDisplay id=${id} name="${trimmedName}"`);
    this.state = { ...this.state, displays };
    await settingsStore.patch({ displays });
    this.broadcast();
    return this.state;
  }

  async setDisplayKind(id: string, kind: DisplayInfo["kind"]): Promise<StageState> {
    if (!this.state.displays.find((d) => d.id === id)) {
      throw new Error(`displays:setKind — display ${id} not found`);
    }
    const displays = this.state.displays.map((d) => (d.id === id ? { ...d, kind } : d));
    console.log(`[stage-controller] setDisplayKind id=${id} kind=${kind}`);
    this.state = { ...this.state, displays };
    await settingsStore.patch({ displays });
    this.broadcast();
    return this.state;
  }

  async removeDisplay(id: string): Promise<StageState> {
    if (this.state.displays.length <= 1) {
      throw new Error("displays:remove — cannot remove the last display");
    }
    if (!this.state.displays.find((d) => d.id === id)) {
      throw new Error(`displays:remove — display ${id} not found`);
    }
    console.log(`[stage-controller] removeDisplay id=${id}`);

    const displays = this.state.displays.filter((d) => d.id !== id);
    this.state = { ...this.state, displays };
    await settingsStore.patch({ displays });

    // Remove slots from disk and memory.
    await slotsStore.removeDisplay(id);
    this.rawSlotsByDisplay.delete(id);

    await this.reResolveAll();
    this.broadcast();
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
    // Re-resolve all displays without clearing PCO data.
    const slotsByDisplay: Record<string, Slot[]> = {};
    for (const display of this.state.displays) {
      const raw = this.rawSlotsByDisplay.get(display.id) ?? [];
      slotsByDisplay[display.id] = resolveSlots(raw, this.teamMembers, this.deviceStatuses);
    }
    const primarySlots = slotsByDisplay[this.primaryDisplayId()] ?? [];
    this.state = {
      ...this.state,
      slotsByDisplay,
      slots: primarySlots,
    };
    this.broadcast();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private primaryDisplayId(): string {
    return this.state.displays[0]?.id ?? PRIMARY_DISPLAY_ID;
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

  /** Load raw slots for every display for the given service type. */
  private async loadAllDisplayRawSlots(serviceTypeId: string): Promise<void> {
    for (const display of this.state.displays) {
      const slots = await slotsStore.getSlots(display.id, serviceTypeId);
      this.rawSlotsByDisplay.set(display.id, slots);
    }
  }

  /** Re-resolve all displays and update state.slotsByDisplay + state.slots. */
  private async reResolveAll(): Promise<void> {
    const slotsByDisplay: Record<string, Slot[]> = {};
    for (const display of this.state.displays) {
      const raw = this.rawSlotsByDisplay.get(display.id) ?? [];
      slotsByDisplay[display.id] = resolveSlots(raw, this.teamMembers, this.deviceStatuses);
    }
    const primarySlots = slotsByDisplay[this.primaryDisplayId()] ?? [];
    this.state = {
      ...this.state,
      slotsByDisplay,
      slots: primarySlots,
    };
  }

  private broadcast(): void {
    broadcast("stage:state-changed", this.state);
  }
}

export const stageController = new StageController();
