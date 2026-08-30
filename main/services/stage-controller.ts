// Single source of truth for all stage state.
// Every mutating method ends with broadcast("stage:state-changed").

import { cloneLayoutWithMap, defaultCustomLayout, defaultViewName, forEachInlineSlotsGrid, forEachViewSourcedSlotsGrid } from "./layout-clone.js";
import { migrateSurfaces, migrationLog } from "./surface-migration.js";
import { migrateNeverChosenDefaults, countNeverChosen } from "./never-chosen-defaults.js";
import { seedHomeView, screensListViews, HOME_VIEW_ID } from "./home-view";
import { notesStore, type NotesContent } from "./notes-store.js";
import { checklistTicksStore } from "./checklist-ticks-store.js";
import {
  planChecklistItems,
  selectNotes,
  type PlanChecklistDTO,
} from "./plan-note-checklist.js";
import { barConfigStore } from "./bar-config-store.js";
import { savedColorsStore } from "./saved-colors-store.js";
import { viewSurface, outputMode, type ViewSurface, type OutputMode } from "../types/views.js";
import { clamp } from "./clamp.js";
import { randomUUID } from "crypto";
import { scrub } from "./scrub.js";
import { appTimeZone, hostTimeZone, isValidTimeZone, setAppTimeZone, zonedParts } from "./app-timezone.js";
import { buildGrid, gridWindow, monthAnchor } from "./calendar-grid.js";
import { pcoCalendarService } from "./pco-calendar-service.js";
import type {
  CalendarGrid,
  CalendarSelection,
  CalendarSourceDTO,
  CalendarTagDTO,
} from "../types/calendar.js";

import type { AutoUpdateSettings, ChargerBayDTO, DisplayInfo, LayoutDTO, Output, PcoAttachmentDTO, PcoLiveDTO, PlanDTO, PlanItemsDTO, ReconnectSchedule, ResolvedOutput, ScriptViewConfig, ScriptViewLayout, ScriptViewRundownDTO, ServiceTypeDTO, Slot, SlotPreset, SlotsLayout, StageState, BaptismAutoStart, TaperWindow, TeamMemberDTO, TeamPositionDTO, View, ViewKind } from "../types/stage.js";
import { WIRELESS_STATUS_CHANNEL, type DeviceStatus } from "../types/devices.js";
import { broadcast, channelHasSubscribers, channelInDemand } from "./broadcaster.js";
import { pcoService } from "./pco-service.js";
import { presetsStore } from "./presets-store.js";
import { resolveSlots } from "./slot-resolver.js";
import { migrateInlineBrandingImages } from "./branding-image-store.js";
import { settingsStore, DEFAULT_TAPER_WINDOW } from "./settings-store.js";
import { slotsStore } from "./slots-store.js";
import { viewsStore } from "./views-store.js";
import { scriptViewLayoutsStore } from "./scriptview-layouts-store.js";
import { scriptViewConfigStore } from "./scriptview-config-store.js";
import { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } from "./service-window.js";
import { updater } from "./updater.js";
import { announceIfNew } from "./update/announce.js";
import { validateSlug } from "./reserved-slugs.js";
import { scriptViewRolesStore, seedRoles } from "./scriptview-roles-store.js";
import type { CategoryRole } from "../types/scriptview-roles.js";

const PRIMARY_DISPLAY_ID = "display-1";

/**
 * The embedded-view font size that shipped as the palette default, and the one
 * that replaced it.
 *
 * `OLD` rendered at ~32px on a 1080-tall screen where the ScriptView page renders
 * at ~17px, so an embed came out at nearly double the page and showed a third of
 * the rundown. Changing the palette default fixed new objects and did nothing for
 * existing ones: the value is written into the object when it is placed, so
 * `style.fontSize ?? DEFAULT` never falls through for anything already saved.
 *
 * Kept as literals rather than imported from the renderer's registry: this is a
 * migration, and it must keep meaning "whatever the bad default WAS" even after
 * the registry moves on again.
 */
const EMBED_FONT_OLD_DEFAULT = 0.03;
const EMBED_FONT_NEW_DEFAULT = 0.016;

/**
 * Retune embedded-view objects still carrying the old default font size.
 *
 * Only an EXACT match is touched. Anything else is a size somebody chose, and
 * this must not overwrite an operator's work — if a display has been deliberately
 * set large for a room, it stays large. An exact 0.03 is the value the palette
 * wrote, not a decision: the field renders identically at 0.0299 or 0.0301, so
 * nobody arrives at exactly the default by taste.
 *
 * Idempotent, because it runs on every load: once rewritten the value no longer
 * matches, so the second pass changes nothing and saves nothing.
 */
export function retuneEmbedFontSize(views: View[]): { views: View[]; changed: number } {
  let changed = 0;
  const next = views.map((v) => {
    if (!v.layout?.objects?.length) return v;
    let touched = false;
    const objects = v.layout.objects.map(function retune(o): LayoutObject {
      // Containers nest, and an embed inside one is just as wrong as a top-level
      // one — the recursion is the whole reason this is not a flat filter.
      const children = o.children?.map(retune);
      const isStaleEmbed =
        o.config.type === "view-embed" && o.style?.fontSize === EMBED_FONT_OLD_DEFAULT;
      if (!isStaleEmbed && !children) return o;
      if (isStaleEmbed) { changed++; touched = true; }
      return {
        ...o,
        ...(children ? { children } : {}),
        ...(isStaleEmbed ? { style: { ...o.style, fontSize: EMBED_FONT_NEW_DEFAULT } } : {}),
      };
    });
    // A child-only change still has to be written back up through the parent.
    if (!touched && objects.every((o, i) => o === v.layout!.objects[i])) return v;
    return { ...v, layout: { ...v.layout, objects } };
  });
  if (changed > 0) {
    console.log(
      `[stage-controller] retuned ${changed} embedded view(s) from the old ${EMBED_FONT_OLD_DEFAULT} font size to ${EMBED_FONT_NEW_DEFAULT}`,
    );
  }
  return { views: next, changed };
}

/**
 * Read the persisted auto-update settings, migrating the pre-mode boolean.
 * `enabled: true` meant "apply and restart in the window", which is auto-full;
 * `false`/absent meant nothing automatic at all, which is manual.
 */
function migrateAutoUpdate(saved: unknown): AutoUpdateSettings {
  const o = (saved ?? {}) as Partial<AutoUpdateSettings> & { enabled?: boolean };
  const mode: AutoUpdateSettings["mode"] =
    o.mode === "auto-install" || o.mode === "auto-full" || o.mode === "manual"
      ? o.mode
      : o.enabled === true
        ? "auto-full"
        : "manual";
  return {
    mode,
    dayOfWeek: typeof o.dayOfWeek === "number" ? o.dayOfWeek : null,
    hour: typeof o.hour === "number" ? o.hour : 3,
  };
}

// Coalescing window (ms) for live device-status updates. Wireless metering arrives
// ~1/sec per channel; we collapse bursts into one re-resolve+broadcast per window
// so the event loop isn't saturated, while keeping the RF bars visually live.
const DEVICE_STATUS_FLUSH_MS = 150;

/**
 * How often the roster is re-pulled while a service window is open.
 *
 * A roster change is a human editing a plan in Planning Center — a substitution
 * typed in minutes before doors, at worst. One minute is under the granularity at
 * which those edits actually happen, so it turns "up to two hours behind" into
 * "about a minute behind" and there is nothing to gain from going tighter.
 *
 * The cost is one request per tick against an API that allows roughly 100 per 20
 * seconds: about 240 requests across a default four-hour window, a few hundred a
 * week, and none at all outside a window. Faster would buy no freshness a person
 * could produce.
 *
 * Independent of the cache TTL in either direction: the tick invalidates the
 * roster entry before reading (`fresh: true`), so this cadence is exactly this
 * number and does not become an accident of whatever TTL a later release picks.
 */
export const ROSTER_WINDOW_INTERVAL_MS = 60_000;

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

/**
 * A layout save was built on a revision someone else has already replaced.
 *
 * Its own type so the route can answer 409 rather than a generic 500: this is not
 * a failure, it is two people editing the same view, and the caller has a real
 * choice to make between reloading and overwriting.
 */
export class LayoutConflictError extends Error {
  readonly code = "layout-conflict";
  constructor(
    readonly viewId: string,
    readonly expectedRev: number,
    readonly currentRev: number,
  ) {
    super(
      `This view was changed by someone else while you were editing it ` +
        `(you started from revision ${expectedRev}, it is now ${currentRev}).`,
    );
    this.name = "LayoutConflictError";
  }
}

/**
 * Write one operator-keyed entry into an icon map, safely.
 *
 * The key comes off an HTTP body, and `map[key] = value` with a key like
 * `__proto__` writes the OBJECT PROTOTYPE rather than an entry — every object in
 * the process then carries the property. CodeQL calls it js/remote-property-
 * injection and it is right to: both icon setters had the same three lines, and
 * both were reachable from an unauthenticated POST on the LAN.
 *
 * Two defences, because either alone is thinner than it looks. The key SHAPE is
 * checked — real keys are display ids ("display-1"), tool paths ("/baptism") and
 * view ids, none of which need anything outside this class. And the map is
 * rebuilt with a null prototype, so an assignment has no prototype to reach even
 * if a future caller skips the check.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function writeIconEntry(
  current: Record<string, string> | undefined,
  key: string,
  value: string,
  label: string,
): Record<string, string> {
  if (!/^[A-Za-z0-9/_-]{1,64}$/.test(key) || FORBIDDEN_KEYS.has(key)) {
    throw new Error(`${label} — key must be an id or a tool path`);
  }
  const next: Record<string, string> = Object.assign(Object.create(null), current ?? {});
  if (value === "") delete next[key];
  else next[key] = value;
  // Back to an ordinary object for JSON.stringify, which skips a null-prototype
  // object's entries in some serialisers and is not worth the risk here.
  return { ...next };
}

export class StageController {
  private state: StageState = {
    serviceTypeId: null,
    serviceTypeName: null,
    planMode: "auto",
    planId: null,
    planTitle: null,
    planSeriesTitle: null,
    planDates: null,
    views: [{ id: PRIMARY_DISPLAY_ID, name: "Slots", kind: "slots", ndiSource: null, createdAt: "" }],
    outputs: [{ id: PRIMARY_DISPLAY_ID, name: "Display 1", viewId: PRIMARY_DISPLAY_ID }],
    slotsByView: {},
    barItems: [],
    savedColors: [],
    notesByObject: {},
    slotsByLayoutObject: {},
    resolvedByOutput: {},
    chargerBays: [],
    pcoConfigured: false,
    lastRefreshedAt: null,
    remoteUrl: null,
    lanUrl: null,
    showQr: true,
    kioskDiscovery: false,
    allowedServiceTypeIds: [],
    checklistNoteCategories: [],
    checklistNoteTeams: [],
    appName: "Stage Utility",
    accentColor: null,
    appLogo: null,
    appLogoMonochrome: true,
    emptySlotLogo: null,
    defaultAvatar: null,
    ndiEnabled: false,
    publicUrl: null,
    captionChannelColors: {},
    autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
    reconnectSchedule: { ...DEFAULT_RECONNECT_SCHEDULE },
    taperWindow: { ...DEFAULT_TAPER_WINDOW },
    timezone: null,
    hourCycle: "24h",
    hostTimezone: hostTimeZone(),
    baptismAutoStart: { enabled: false, testimonyKeyword: "baptism stories" },
    onboardingDismissed: false,
  };

  // Live device statuses keyed by channelId.
  private deviceStatuses = new Map<string, DeviceStatus>();
  // Wireless connection display names keyed by connectionId — used to label
  // charger bays by the user's connection name instead of an arbitrary index.
  private connectionNames = new Map<string, string>();
  // Coalesce timer for device-status updates (see applyDeviceStatus).
  private deviceStatusFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDeviceSig: string | null = null;
  private deviceStatusDirty = false; // device status changed while no client watched
  // Cached team members for the active plan.
  private teamMembers: TeamMemberDTO[] = [];
  /** `serviceTypeId:planId` the roster above belongs to, so a failed refresh can
   *  tell "the same plan, momentarily unreachable" from "a different plan". */
  private teamMembersKey: string | null = null;

  /** The plan's scheduled team, for the roster-driven automation action. A copy,
   *  so a caller cannot mutate the controller's own list. */
  getTeamMembers(): TeamMemberDTO[] {
    // Defensive: an action provider must never throw, and this is the seam it
    // reads the roster through.
    return Array.isArray(this.teamMembers) ? this.teamMembers.map((m) => ({ ...m })) : [];
  }
  // Raw (un-resolved) slot configs per VIEW id for the ACTIVE service type.
  private rawSlotsByView = new Map<string, Slot[]>();
  // Raw (unresolved) slots for inline mic-slots objects, keyed by layout object id,
  // for the active service type. Resolved into state.slotsByLayoutObject.
  private rawSlotsByObject = new Map<string, Slot[]>();
  // In-flight background plan re-selection, and whether the selection changed
  // again while it was running. See scheduleGlobalReselect.
  private reselectInFlight: Promise<void> | null = null;
  private reselectAgain = false;

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
  /** Remembered so pauseBackgroundWork can restart at the same cadence. */
  private autoRefreshIntervalMs = 60 * 60 * 1000;
  private isRefreshing = false;
  /** Roster-only re-pull, and only while a service window is open. */
  private rosterRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** A roster tick is in flight — a slow one must not overlap the next. */
  private rosterRefreshing = false;

  // ── Init ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await notesStore.init();
    await barConfigStore.init();
    await savedColorsStore.init();
    console.log("[stage-controller] init");
    let settings = await settingsStore.load();

    // Installs made before branding images moved to files still hold base64 in
    // settings. Convert once, then carry on with the rewritten values — otherwise
    // this boot would broadcast the old inline data and rewrite it on the next patch.
    const { patch, converted } = await migrateInlineBrandingImages(settings);
    if (converted.length > 0) {
      settings = await settingsStore.patch(patch);
      console.log(`[stage-controller] moved ${scrub(converted.length)} branding image(s) out of settings:`, converted.join(", "));
    }

    const showQr = settings.showQr ?? true;
    const kioskDiscovery = settings.kioskDiscovery ?? false;

    const { views, outputs } = await this.loadOrMigrateViewsAndOutputs(settings);

    // Every install that predates id floors has ids and no floor, and a missing
    // floor falls back to `max(existing) + 1` — the bug. Seeding here, from what
    // was just loaded, is what stops the FIRST delete-then-create after an update
    // reissuing the highest id. Only kinds with no floor recorded are touched.
    await settingsStore.seedIdFloors({
      view: views.map((v) => v.id),
      output: outputs.map((o) => o.id),
    });

    // An EMPTY list means "all allowed" and is passed through as such.
    //
    // This used to substitute four hardcoded ids for an empty list, which made
    // the documented "empty = all" unreachable at boot: the Plan tab normalises
    // "everything on" to [], so turning every service type on and restarting
    // silently re-restricted the install to those four. On any org but the one
    // the ids came from, they match nothing — so a fresh install could not pick
    // a service type at all, with an empty picker and nothing to explain it.
    const allowedServiceTypeIds: string[] = Array.isArray(settings.allowedServiceTypeIds)
      ? settings.allowedServiceTypeIds
      : [];

    this.state = {
      ...this.state,
      // Loaded above; without this the field stays {} and every note reads empty
      // until the first edit — the content would look lost.
      barItems: barConfigStore.get().items,
      savedColors: savedColorsStore.all(),
      notesByObject: notesStore.all(),
      serviceTypeId: settings.serviceTypeId,
      serviceTypeName: settings.serviceTypeName,
      planMode: settings.planMode,
      planId: settings.planId,
      planTitle: settings.planTitle,
      planSeriesTitle: settings.planSeriesTitle ?? null,
      planDates: settings.planDates ?? null,
      views,
      outputs,
      showQr,
      kioskDiscovery,
      allowedServiceTypeIds,
      checklistNoteCategories: settings.checklistNoteCategories ?? [],
      checklistNoteTeams: settings.checklistNoteTeams ?? [],
      appName: settings.appName ?? "Stage Utility",
      accentColor: settings.accentColor ?? null,
      appLogo: settings.appLogo ?? null,
      appLogoMonochrome: settings.appLogoMonochrome ?? true,
      emptySlotLogo: settings.emptySlotLogo ?? null,
      defaultAvatar: settings.defaultAvatar ?? null,
      ndiEnabled: settings.ndiEnabled ?? false,
      publicUrl: settings.publicUrl ?? null,
      // Both of these are written to settings.json by their setters and were
      // never read back here, so an icon colour survived until the next restart
      // and then silently reverted to the theme accent. Verified against a real
      // server: set, confirmed in state and on disk, restarted, gone.
      iconColors: settings.iconColors ?? {},
      iconGlyphs: settings.iconGlyphs ?? {},
      captionChannelColors: settings.captionChannelColors ?? {},
      autoUpdate: migrateAutoUpdate(settings.autoUpdate),
      reconnectSchedule: settings.reconnectSchedule ?? { ...DEFAULT_RECONNECT_SCHEDULE },
      taperWindow: settings.taperWindow ?? { ...DEFAULT_TAPER_WINDOW },
      timezone: settings.timezone ?? null,
      hourCycle: settings.hourCycle ?? "24h",
      hostTimezone: hostTimeZone(),
      baptismAutoStart: settings.baptismAutoStart ?? { enabled: false, testimonyKeyword: "baptism stories" },
      onboardingDismissed: settings.onboardingDismissed ?? false,
    };
    this.publicUrl = settings.publicUrl ?? null;
    this.applyRemoteUrl();
    serviceWindow.setSchedule(this.state.reconnectSchedule);
    this.startUpdateChecks();

    await this.loadAllViewRawSlots(settings.serviceTypeId);
    this.recomputeResolved();

    console.log("[stage-controller] loaded settings", {
      serviceTypeId: this.state.serviceTypeId,
      planId: this.state.planId,
      planMode: this.state.planMode,
      showQr: this.state.showQr,
      kioskDiscovery: this.state.kioskDiscovery,
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
      const { views, changed } = retuneEmbedFontSize(storedViews);
      if (changed > 0) await viewsStore.save(views);
      return this.applySurfaceMigration(views, storedOutputs);
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
    return this.applySurfaceMigration(views, outputs);
  }

  /**
   * Give every View a surface and every Output a mode, preserving behaviour.
   *
   * Applied on BOTH load paths — the stored one and the first-run legacy one —
   * because a migration that runs on only one of two paths is how half an
   * install ends up on a schema the rest of the code assumes. Persisted, so it
   * decides once rather than on every boot; the decision is then the operator's
   * to change.
   */
  private async applySurfaceMigration(
    views: View[],
    outputs: Output[],
  ): Promise<{ views: View[]; outputs: Output[] }> {
    // Home is seeded here rather than in its own pass: both run on load, both
    // may write views, and two writers racing over the same file is how one of
    // them loses. Seeding first means the surface migration also sees Home.
    const seeded = seedHomeView(views);
    // Objects shed the translucent card ground the registry wrote into them at
    // creation and nobody ever chose. Runs in this same pass for the same reason
    // Home is seeded here: one writer for views.json, not three.
    //
    // ONCE, and the flag is why: a value the registry wrote and one the operator
    // chose are the same characters in the file, so a pass that runs every load
    // cannot tell them apart. It used to take readouts' alignment as well, and
    // took the operator's centre away on every restart — which is every update.
    // That half is gone (see never-chosen-defaults.ts); this half stops after
    // its one pass.
    const alreadyCleaned = (await settingsStore.get()).layoutDefaultsCleaned === true;
    const cleaned = alreadyCleaned ? (seeded as View[]) : migrateNeverChosenDefaults(seeded as View[]);
    const cleanedCount = alreadyCleaned ? 0 : countNeverChosen(seeded as View[]);
    // Recorded even when it found nothing: a fresh install has nothing to clean,
    // and must still never run it again.
    if (!alreadyCleaned) await settingsStore.patch({ layoutDefaultsCleaned: true });
    if (cleanedCount > 0) {
      console.log(
        `[layout-defaults] ${cleanedCount} object${cleanedCount === 1 ? "" : "s"} carried a card ground written by ` +
          "the object registry rather than chosen — a translucent one, which let the page read through the " +
          "widget, or the older #191919 card, which left one layout wearing two different cards. Replaced " +
          "with the current opaque card, once. Still editable per object in the layout editor.",
      );
    }
    const result = migrateSurfaces(cleaned, outputs);
    const viewsChanged = result.views.length !== views.length || result.views.some((v, i) => v !== views[i]);
    const outputsChanged = result.outputs.some((o, i) => o !== outputs[i]);
    if (!viewsChanged && !outputsChanged) return { views, outputs };

    if (viewsChanged) await viewsStore.save(result.views);
    if (outputsChanged) await settingsStore.patch({ outputs: result.outputs });

    // Logged in full: a stray live-controls left on a wall display years ago
    // will pull that screen into panel mode, and the only way an operator learns
    // that is by being told.
    for (const line of migrationLog(result)) {
      console.log(`[surface-migration] ${scrub(line)}`);
    }
    return { views: result.views, outputs: result.outputs };
  }

  // ── PCO credentials ───────────────────────────────────────────────────

  setPcoCredentials(appId: string | null, secret: string | null, countdownTarget?: "plan-start" | "service-time"): void {
    this.pcoAppId = appId;
    this.pcoSecret = secret;
    if (countdownTarget) this.pcoCountdownTarget = countdownTarget;
    this.state = { ...this.state, pcoConfigured: !!(appId && secret) };
    void this.refreshServiceWindows(); // creds (re)applied — (re)compute reconnect windows
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
  /**
   * Tint one item's icon. `key` is a display id ("display-1") or a tool path
   * ("/baptism"); one map so a color set on the Screens page or Connect also
   * shows on the picker at /. An empty color clears the entry back to the theme
   * default rather than storing a sentinel.
   */
  async setIconColor(key: string, color: string): Promise<StageState> {
    const k = key.trim();
    if (!k) throw new Error("icon-color — key required");
    const c = color.trim().toLowerCase();
    if (c !== "" && !/^#[0-9a-f]{6}$/.test(c)) {
      throw new Error('icon-color — color must be "#rrggbb" or "" to clear');
    }
    const next = writeIconEntry(this.state.iconColors, k, c, "icon-color");
    console.log(`[stage-controller] setIconColor ${scrub(k)} → ${scrub(c || "(cleared)")}`);
    this.state = { ...this.state, iconColors: next };
    await settingsStore.patch({ iconColors: next });
    this.broadcast();
    return this.state;
  }

  /**
   * The icon GLYPH for a display or tool, by the same key its colour uses.
   *
   * "" clears it, exactly as a colour does, and clearing means "fall back to the
   * item's built-in icon" rather than "no icon". The NAME is stored, not a
   * component: the renderer owns the set, so a name this build cannot resolve
   * falls back rather than blanking — a curated set trimmed in a later release
   * must not leave an operator staring at a hole where their icon was.
   */
  async setIconGlyph(key: string, glyph: string): Promise<StageState> {
    const k = key.trim();
    if (!k) throw new Error("icon-glyph — key required");
    const g = glyph.trim();
    // Name-shaped only. Anything else is a caller bug, and storing it would put
    // a value in settings.json that nothing can ever render.
    if (g !== "" && !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(g)) {
      throw new Error('icon-glyph — glyph must be an icon name or "" to clear');
    }
    const next = writeIconEntry(this.state.iconGlyphs, k, g, "icon-glyph");
    console.log(`[stage-controller] setIconGlyph ${scrub(k)} → ${scrub(g || "(cleared)")}`);
    this.state = { ...this.state, iconGlyphs: next };
    await settingsStore.patch({ iconGlyphs: next });
    this.broadcast();
    return this.state;
  }

  async setPublicUrl(url: string | null): Promise<StageState> {
    const normalized = normalizeBaseUrl(url);
    console.log(`[stage-controller] setPublicUrl → ${scrub(normalized ?? "(cleared)")}`);
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

  /**
   * The DisplayInfo compatibility shim, built on demand for `GET /api/displays`.
   *
   * It used to be stored on StageState and broadcast to every client, but nothing
   * in the app read it — each view wanted a name (on the Output) or a kind (on the
   * routed View). Only external callers still ask for this shape, and they ask over
   * HTTP, so it is assembled here instead of riding in every push.
   */
  getDisplays(): DisplayInfo[] {
    return this.state.outputs.map((o) => {
      const view = o.viewId ? this.state.views.find((v) => v.id === o.viewId) ?? null : null;
      return { id: o.id, name: o.name, kind: view?.kind ?? "slots", ndiSource: view?.ndiSource ?? null };
    });
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

    console.log(`[stage-controller] setServiceType → ${scrub(id)} (${scrub(found.name)})`);

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

  /**
   * Plans for the manual picker: the last 30 days, then everything upcoming.
   *
   * Past plans are here and nowhere else — auto selection and the reconnect
   * windows use `listUpcomingPlans` directly, so neither can land on a service
   * that has already happened.
   */
  async listPlans(serviceTypeId: string): Promise<PlanDTO[]> {
    this.assertPco();
    const [past, future] = await Promise.all([
      pcoService
        .listRecentPlans(this.pcoAppId!, this.pcoSecret!, serviceTypeId)
        .catch(() => [] as PlanDTO[]),
      pcoService.listUpcomingPlans(this.pcoAppId!, this.pcoSecret!, serviceTypeId),
    ]);
    // Oldest → newest, and de-duplicated: a plan happening today can come back
    // from both filters depending on where PCO draws the line.
    const seen = new Set(future.map((p) => p.id));
    return [
      ...past.filter((p) => !seen.has(p.id)).reverse().map((p) => ({ ...p, past: true })),
      ...future,
    ];
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

  // ── Pre-service checklist, sourced from Planning Center plan notes ───────
  //
  // The checklist an operator ticks off here is the note their team lead already
  // writes on the plan each week. Nothing is authored in this app, deliberately:
  // a second copy would go stale the first week somebody edited one and not the
  // other, and the PCO note is the one the rest of the team already reads.

  /**
   * The active plan's checklist: the chosen plan notes, flattened to rows, with
   * this plan's ticks applied.
   *
   * Returns an empty, `unconfigured: false` result when PCO is not connected or
   * no plan is selected — there is nothing to configure yet in either case, and
   * telling somebody to pick a note category before they have connected PCO is
   * advice they cannot act on.
   */
  async listPlanChecklist(): Promise<PlanChecklistDTO> {
    const planId = this.state.planId;
    const empty: PlanChecklistDTO = { planId, rows: [], unconfigured: false };
    if (!this.pcoAppId || !this.pcoSecret) return empty;
    if (!this.state.serviceTypeId || !planId) return empty;

    const settings = await settingsStore.get();
    const categories = settings.checklistNoteCategories ?? [];
    const teams = settings.checklistNoteTeams ?? [];
    if (categories.length === 0 && teams.length === 0) {
      return { planId, rows: [], unconfigured: true };
    }

    const notes = await pcoService.listPlanNotes(
      this.pcoAppId,
      this.pcoSecret,
      this.state.serviceTypeId,
      planId,
    );
    const ticked = new Set(checklistTicksStore.get(planId));
    const rows = planChecklistItems(selectNotes(notes, categories, teams)).map((item) => ({
      ...item,
      done: ticked.has(item.key),
    }));
    return { planId, rows, unconfigured: false };
  }

  /**
   * Tick or untick one row, and hand back the whole list as it now stands.
   *
   * Returning the list rather than void is what stops the UI having to guess:
   * the caller renders what the server says instead of applying its own optimism
   * and hoping the two agree. The store's write is awaited, so a failed save
   * reaches the operator instead of looking saved until the next restart.
   */
  async setChecklistTick(key: string, done: boolean): Promise<PlanChecklistDTO> {
    const planId = this.state.planId;
    if (!planId) throw new Error("No plan is selected, so there is nothing to tick");
    await checklistTicksStore.set(planId, key, done);
    return this.listPlanChecklist();
  }

  /** Clear every tick on the active plan — "start this week over". */
  async clearChecklistTicks(): Promise<PlanChecklistDTO> {
    const planId = this.state.planId;
    if (!planId) throw new Error("No plan is selected, so there is nothing to clear");
    await checklistTicksStore.clear(planId);
    return this.listPlanChecklist();
  }

  /**
   * Choose which plan notes feed the checklist.
   *
   * Stored as NAMES because that is what a note carries. A category renamed in
   * PCO stops matching, which is the right behaviour: the operator renamed the
   * thing they were pointing at, and silently following a rename would be a
   * guess about intent this app is not entitled to make.
   */
  async setChecklistSources(categories: string[], teams: string[]): Promise<StageState> {
    const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
    await settingsStore.patch({
      checklistNoteCategories: clean(categories),
      checklistNoteTeams: clean(teams),
    });
    this.state = {
      ...this.state,
      checklistNoteCategories: clean(categories),
      checklistNoteTeams: clean(teams),
    };
    this.broadcast();
    return this.state;
  }

  /**
   * The plan-note categories and team names this service type actually offers,
   * for the settings picker.
   *
   * Read live rather than stored: a category renamed in PCO must show up under
   * its new name, and a picker built from a stale copy is how somebody ends up
   * choosing an option that matches nothing.
   */
  async listChecklistSources(): Promise<{ categories: string[]; teams: string[] }> {
    const none = { categories: [], teams: [] };
    if (!this.pcoAppId || !this.pcoSecret || !this.state.serviceTypeId) return none;
    const [categories, teams] = await Promise.all([
      pcoService.listPlanNoteCategories(this.pcoAppId, this.pcoSecret, this.state.serviceTypeId),
      pcoService.listTeamNames(this.pcoAppId, this.pcoSecret, this.state.serviceTypeId),
    ]);
    return { categories, teams };
  }

  /**
   * This month's Planning Center Calendar, already bucketed into squares.
   *
   * Built here, never in the browser. The squares are calendar DAYS, and which
   * day an instant falls on is a question only the app time zone can answer —
   * see calendar-grid.ts. The renderer gets days and a zone, not instants and a
   * guess.
   *
   * `monthOffset` 0 — the default and the only value the broadcaster ever uses —
   * is the CURRENT month in the app's zone, so the grid rolls over by itself with
   * no state to go stale on a display nobody touches for a year. A non-zero
   * offset is a one-shot answer to an operator paging back or forward; nothing
   * subscribes to it, because a past month is not going to change under them.
   *
   * A failure to reach PCO PROPAGATES — the route answers 502 and the display
   * says it could not read the calendar. An empty grid would be a lie, and a
   * month that quietly empties itself is exactly the kind of absence nobody
   * reports.
   */
  async getCalendarGrid(viewId: string | null, monthOffset = 0): Promise<CalendarGrid> {
    const zone = appTimeZone();
    // Throws on an offset outside the paging bound, which the route turns into a
    // 400. A silent clamp would draw a different month than the one asked for and
    // say nothing about it.
    const anchorIso = monthAnchor(monthOffset, zone);
    // Not configured is not an error: a display routed to a calendar before
    // Planning Center is connected should draw an empty month, and the renderer
    // reads pcoConfigured off the state it already has to say which it is.
    if (!this.pcoAppId || !this.pcoSecret) return buildGrid([], anchorIso, zone);

    // Empty is NOT an empty filter — it is no filter, and PCO is asked for
    // everything. See View.calendarSources for why that is the opposite of the
    // checklist's rule.
    // No re-filtering of the ids: setViewCalendarFilters is the only writer and
    // it trims, drops blanks and de-duplicates on the way in.
    const view = viewId ? this.state.views.find((v) => v.id === viewId) ?? null : null;
    const calendarIds = (view?.calendarSources ?? []).map((s) => s.id);
    const tagIds = (view?.calendarTags ?? []).map((s) => s.id);

    const { fromIso, toIso } = gridWindow(anchorIso, zone);
    const events = await pcoCalendarService.listEventInstances(this.pcoAppId, this.pcoSecret, {
      fromIso,
      toIso,
      calendarIds,
      tagIds,
    });
    return buildGrid(events, anchorIso, zone);
  }

  /**
   * The org's calendars and tags, for the two pickers.
   *
   * Read live rather than stored, for the reason listChecklistSources is: a tag
   * renamed in Planning Center must appear under its new name, and a picker
   * built from a remembered copy is how somebody chooses an option that matches
   * nothing and cannot tell why their calendar is empty.
   */
  async listCalendarSources(): Promise<{ calendars: CalendarSourceDTO[]; tags: CalendarTagDTO[] }> {
    if (!this.pcoAppId || !this.pcoSecret) return { calendars: [], tags: [] };
    const [calendars, tags] = await Promise.all([
      pcoCalendarService.listCalendars(this.pcoAppId, this.pcoSecret),
      pcoCalendarService.listCalendarTags(this.pcoAppId, this.pcoSecret),
    ]);
    return { calendars, tags };
  }

  /**
   * Which calendars and tags a calendar View draws.
   *
   * Both lists are stored WHOLE — an id with the name it read as when it was
   * chosen. Unlike setViewScriptViewLayout, an id PCO no longer offers is NOT
   * refused: a tag deleted in Planning Center would then either silently widen
   * the filter or fail every save the operator makes afterwards. It is kept, and
   * the picker shows it marked, so the choice is visible and theirs to remove.
   */
  async setViewCalendarFilters(
    id: string,
    calendarSources: CalendarSelection[],
    calendarTags: CalendarSelection[],
  ): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setCalendarFilters — view ${id} not found`);
    }
    const clean = (list: CalendarSelection[]): CalendarSelection[] => {
      const seen = new Set<string>();
      const out: CalendarSelection[] = [];
      for (const s of list) {
        const sid = typeof s?.id === "string" ? s.id.trim() : "";
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        out.push({ id: sid, name: typeof s.name === "string" ? s.name : "" });
      }
      return out;
    };
    const views = this.state.views.map((v) =>
      v.id === id ? { ...v, calendarSources: clean(calendarSources), calendarTags: clean(calendarTags) } : v,
    );
    console.log(
      `[stage-controller] setViewCalendarFilters id=${scrub(id)} calendars=${scrub(calendarSources.length)} tags=${scrub(calendarTags.length)}`,
    );
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  // ── ScriptView (in-app ScriptViewer replacement) ────────────────────────

  async listScriptViewLayouts(): Promise<ScriptViewLayout[]> {
    return scriptViewLayoutsStore.load();
  }

  /**
   * Bulk replace — the settings UI manages the whole array and saves it.
   *
   * Views referencing a preset that this save removes are cleared to "all
   * columns" rather than left pointing at nothing. A dangling id degrades in the
   * worst way available: `resolveScriptViewSpec` treats an unresolved preset the
   * same as none and renders EVERY note category, so a display configured for
   * one department quietly starts showing every other department's notes — and
   * the settings picker shows a blank trigger, because the stored value matches
   * no option, so there is nothing on screen to explain it.
   */
  async saveScriptViewLayouts(layouts: ScriptViewLayout[]): Promise<ScriptViewLayout[]> {
    await scriptViewLayoutsStore.save(layouts);
    const live = new Set(layouts.map((l) => l.id));
    const orphaned = this.state.views.filter(
      (v) => v.scriptViewLayoutId && !live.has(v.scriptViewLayoutId),
    );
    if (orphaned.length > 0) {
      console.log(
        `[stage-controller] ${orphaned.length} view(s) referenced a deleted ScriptView preset — ` +
          `cleared to all columns: ${orphaned.map((v) => scrub(v.name)).join(", ")}`,
      );
      const views = this.state.views.map((v) =>
        v.scriptViewLayoutId && !live.has(v.scriptViewLayoutId) ? { ...v, scriptViewLayoutId: null } : v,
      );
      this.state = { ...this.state, views };
      await viewsStore.save(views);
      this.recomputeResolved();
      this.broadcast();
    }
    return layouts;
  }

  async getScriptViewConfig(): Promise<ScriptViewConfig> {
    return scriptViewConfigStore.load();
  }

  async setScriptViewConfig(serviceTypeIds: string[]): Promise<ScriptViewConfig> {
    const config: ScriptViewConfig = { serviceTypeIds };
    await scriptViewConfigStore.save(config);
    return config;
  }

  /** All note-category names PCO knows for a service type (drives the column
   *  picker). Unlike the rundown's `noteCategories`, this is NOT pruned to
   *  categories currently in use, so authors can pre-add a column. */
  async listScriptViewRoles(): Promise<CategoryRole[]> {
    return scriptViewRolesStore.load();
  }

  async saveScriptViewRoles(roles: CategoryRole[]): Promise<CategoryRole[]> {
    const clean = (roles ?? [])
      .filter((r) => r && typeof r.id === "string" && typeof r.name === "string" && r.name.trim())
      .map((r) => ({
        id: r.id,
        name: r.name.trim(),
        members: [...new Set((r.members ?? []).map((m) => String(m).trim()).filter(Boolean))],
      }));
    await scriptViewRolesStore.save(clean);
    this.broadcast();
    return clean;
  }

  /**
   * Add a role for any category this service type defines that no role covers yet.
   *
   * Only ever ADDS. Never merges (that guess is the operator's to make) and never
   * removes (a role may cover a category from a different service type).
   */
  async seedScriptViewRoles(serviceTypeId: string): Promise<CategoryRole[]> {
    const cats = await this.listScriptViewNoteCategories(serviceTypeId);
    const roles = await scriptViewRolesStore.load();
    const covered = new Set(roles.flatMap((r) => r.members.map((m) => m.trim().toLowerCase())));
    const missing = cats.filter((c) => !covered.has(c.trim().toLowerCase()));
    if (missing.length === 0) return roles;
    const next = [...roles, ...seedRoles(missing)];
    await scriptViewRolesStore.save(next);
    this.broadcast();
    return next;
  }

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
      planDates: null, items: [], noteCategories: [], serviceTimes: [], timeZone: null, isActivePlan: false,
    };
    if (!this.pcoAppId || !this.pcoSecret || !serviceTypeId) return empty;

    const plans = await pcoService.listUpcomingPlans(this.pcoAppId, this.pcoSecret, serviceTypeId);
    const isActiveType = serviceTypeId === this.state.serviceTypeId;

    /**
     * Resolve a specific plan, looking BEYOND the upcoming list.
     *
     * `listUpcomingPlans` is `filter=future`, so a plan the operator selected by
     * hand from the recent list is not in it. Falling through to `plans[0]` there
     * silently swapped last Sunday's rundown for next week's — on the stage
     * monitor, with the live highlight and countdown gone because the resolved
     * plan was no longer the active one. Nobody would read that as "wrong plan";
     * it just looks like the service has not started.
     */
    const resolve = async (id: string): Promise<PlanDTO | null> => {
      const upcoming = plans.find((p) => p.id === id);
      if (upcoming) return upcoming;
      const recent = await pcoService.listRecentPlans(this.pcoAppId!, this.pcoSecret!, serviceTypeId);
      return recent.find((p) => p.id === id) ?? null;
    };

    let plan: PlanDTO | null;
    if (planId) plan = await resolve(planId);
    else if (isActiveType && this.state.planId) plan = (await resolve(this.state.planId)) ?? plans[0] ?? null;
    else plan = plans[0] ?? null;
    if (!plan) return empty;

    // serviceTypes is cached for 15 minutes, so pulling the item row colors here
    // costs nothing — the colors ride along on a request already being made.
    const [items, categories, serviceTimes, timeZone, serviceTypes] = await Promise.all([
      pcoService.listPlanItems(this.pcoAppId, this.pcoSecret, serviceTypeId, plan.id),
      pcoService.listItemNoteCategories(this.pcoAppId, this.pcoSecret, serviceTypeId),
      pcoService.listPlanServiceTimes(this.pcoAppId, this.pcoSecret, serviceTypeId, plan.id),
      pcoService.listOrgTimeZone(this.pcoAppId, this.pcoSecret),
      pcoService.listServiceTypes(this.pcoAppId, this.pcoSecret),
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
      itemTypeColors: serviceTypes.find((t) => t.id === serviceTypeId)?.itemTypeColors ?? [],
      serviceTimes,
      timeZone,
      isActivePlan: isActiveType && plan.id === this.state.planId,
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

    console.log(`[stage-controller] setPlan → ${scrub(id)} (${scrub(found.title)})`);
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
      this.state = { ...this.state, planId: null, planTitle: null, planSeriesTitle: null, planDates: null };
      this.teamMembers = [];
      await settingsStore.patch({ planId: null, planTitle: null, planSeriesTitle: null, planDates: null });
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
    console.log(`[stage-controller] selectNextPlan → ${scrub(next.id)} (${scrub(next.title)})`);
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
        // Resolve service ends LAZILY, stopping at the first plan still upcoming.
        // Only the plans that finished today get skipped, so this is normally one
        // lookup and at worst a handful. Resolving all ~25 up front turned every
        // cold cache — which is exactly what a restart after an update leaves —
        // into a burst of concurrent /plan_times calls that PCO answered with 429s.
        let nearest: PlanDTO | null = null;
        for (const p of plans) {
          const endIso = await pcoService
            .getServiceEnd(this.pcoAppId!, this.pcoSecret!, type.id, p.id)
            .catch(() => null);
          if (endIso) {
            const end = Date.parse(endIso);
            if (Number.isFinite(end) && Date.now() > end + StageController.ROLLOVER_GRACE_MS) {
              continue; // finished plan still lingering in filter=future — skip it
            }
          }
          nearest = p; // service still upcoming / within grace, or end unknown
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
        console.error(`[stage-controller] selectGlobalNextPlan — error fetching plans for type ${scrub(type.id)}:`, err);
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
        planDates: null,
        lastRefreshedAt: new Date().toISOString(),
      };
      this.teamMembers = [];
      await settingsStore.patch({ planId: null, planTitle: null, planSeriesTitle: null, planDates: null });
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
    console.log(`[stage-controller] setAllowedServiceTypes → [${scrub(ids.join(", "))}]`);
    this.state = { ...this.state, allowedServiceTypeIds: ids };
    await settingsStore.patch({ allowedServiceTypeIds: ids });
    broadcast("settings:allowedServiceTypeIds-changed", { value: ids });
    this.broadcast();

    // Returns NOW. The re-selection sweep used to be awaited here, which froze the
    // settings checkbox for as long as it took — measured at 12.7s over 43
    // sequential PCO requests on a 20-service-type account. Nothing about the
    // answer is needed to acknowledge the toggle: the new list is already
    // persisted and broadcast above, and the chosen plan arrives as its own
    // broadcast when the sweep lands.
    if (this.state.planMode === "auto") this.scheduleGlobalReselect();
    return this.state;
  }

  /**
   * Re-pick the globally-next plan in the background, at most one sweep at a time.
   *
   * Ticking several service types in a row must not launch a sweep each: they
   * would race to set the plan, and the last one to FINISH would win rather than
   * the last one requested. Instead a sweep already running is asked to repeat
   * once when it finishes, so the final run always reflects the final selection.
   */
  private scheduleGlobalReselect(): void {
    if (this.reselectInFlight) {
      this.reselectAgain = true;
      return;
    }
    this.reselectInFlight = (async () => {
      try {
        do {
          this.reselectAgain = false;
          await this.selectGlobalNextPlan();
        } while (this.reselectAgain);
      } catch (err) {
        // Never throws to a caller — there isn't one. A failed sweep leaves the
        // previous plan in place, which is the safe outcome mid-service.
        console.error("[stage-controller] background plan re-selection failed:", err);
      } finally {
        this.reselectInFlight = null;
      }
    })();
  }

  async setPlanMode(mode: "auto" | "manual"): Promise<StageState> {
    console.log(`[stage-controller] setPlanMode → ${scrub(mode)}`);
    this.state = { ...this.state, planMode: mode };
    await settingsStore.patch({ planMode: mode });
    this.broadcast();

    // Backgrounded for the same reason as setAllowedServiceTypes: the mode change
    // itself is instant, and waiting on the PCO sweep made the Auto button appear
    // frozen for seconds.
    if (mode === "auto") this.scheduleGlobalReselect();
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
      console.log(`[stage-controller] setViewSlots (${scrub(slots.length)} slots) for view=${scrub(viewId)} serviceType=${scrub(this.state.serviceTypeId)}`);
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
      console.log(`[stage-controller] setLayoutObjectSlots (${scrub(slots.length)} slots) for object=${scrub(objectId)} serviceType=${scrub(this.state.serviceTypeId)}`);
      await slotsStore.setSlots(objectId, this.state.serviceTypeId, slots);
    }
    this.rawSlotsByObject.set(objectId, slots);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  // ── QR visibility ─────────────────────────────────────────────────────

  async setShowQr(show: boolean): Promise<StageState> {
    console.log(`[stage-controller] setShowQr → ${scrub(show)}`);
    this.state = { ...this.state, showQr: show };
    await settingsStore.patch({ showQr: show });
    this.broadcast();
    return this.state;
  }

  /**
   * Turn kiosk discovery on or off.
   *
   * Takes effect on the next start rather than immediately: binding a UDP socket
   * is not something to do and undo from a settings toggle mid-service, and the
   * screens already bound keep working either way — a bound device is answered
   * by a running responder and unaffected by this until the server restarts.
   */
  async setKioskDiscovery(on: boolean): Promise<StageState> {
    console.log(`[stage-controller] setKioskDiscovery → ${scrub(on)}`);
    this.state = { ...this.state, kioskDiscovery: on };
    await settingsStore.patch({ kioskDiscovery: on });
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
    console.log(`[stage-controller] setNdiEnabled → ${scrub(enabled)}`);
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
    console.log(`[stage-controller] refreshDisplays → ${scrub(t)}`);
    broadcast("display:refresh", { target: t });
  }

  // ── Self-update (auto-update schedule) ────────────────────────────────

  async setAutoUpdate(partial: Partial<AutoUpdateSettings>): Promise<StageState> {
    const next: AutoUpdateSettings = { ...this.state.autoUpdate, ...partial };
    // Clamp hour to 0–23; dayOfWeek to 0–6 or null.
    next.hour = clamp(Math.round(next.hour), 0, 23);
    next.dayOfWeek =
      next.dayOfWeek == null ? null : clamp(Math.round(next.dayOfWeek), 0, 6);
    console.log(`[stage-controller] setAutoUpdate →`, next);
    this.state = { ...this.state, autoUpdate: next };
    await settingsStore.patch({ autoUpdate: next });
    this.broadcast();
    return this.state;
  }

  // ── Time-aware reconnect scheduling ───────────────────────────────────

  async setReconnectSchedule(partial: Partial<ReconnectSchedule>): Promise<StageState> {
    const next: ReconnectSchedule = { ...this.state.reconnectSchedule, ...partial };
    next.leadMin = clamp(Math.round(next.leadMin), 0, 1440);
    next.tailMin = clamp(Math.round(next.tailMin), 0, 1440);
    next.dormantMin = clamp(Math.round(next.dormantMin), 1, 1440);
    console.log(`[stage-controller] setReconnectSchedule → ${scrub(next)}`);
    this.state = { ...this.state, reconnectSchedule: next };
    await settingsStore.patch({ reconnectSchedule: next });
    serviceWindow.setSchedule(next);
    void this.refreshServiceWindows(); // lead/tail shift the window bounds
    this.broadcast();
    return this.state;
  }

  /** The keyword that lets a plan item start the testimonies by itself. */
  async setBaptismAutoStart(partial: Partial<BaptismAutoStart>): Promise<StageState> {
    const cur = this.state.baptismAutoStart ?? { enabled: false, testimonyKeyword: "baptism stories" };
    const next: BaptismAutoStart = { ...cur, ...partial, testimonyKeyword: (partial.testimonyKeyword ?? cur.testimonyKeyword).slice(0, 80) };
    this.state = { ...this.state, baptismAutoStart: next };
    await settingsStore.patch({ baptismAutoStart: next });
    this.broadcast();
    return this.state;
  }

  async setTaperWindow(partial: Partial<TaperWindow>): Promise<StageState> {
    const next: TaperWindow = { ...this.state.taperWindow, ...partial };
    next.preMin = clamp(Math.round(next.preMin), 0, 240);
    next.postMin = clamp(Math.round(next.postMin), 0, 240);
    console.log(`[stage-controller] setTaperWindow → ${scrub(next)}`);
    this.state = { ...this.state, taperWindow: next };
    await settingsStore.patch({ taperWindow: next });
    this.broadcast();
    return this.state;
  }

  /**
   * Set the zone every wall-clock decision is made in, or null to follow the host.
   *
   * Rejects an unknown zone rather than storing it: a typo here would silently
   * move every schedule and day-of-week condition back to the host clock.
   */
  async setTimezone(tz: string | null): Promise<StageState> {
    const next = tz && tz.trim() ? tz.trim() : null;
    if (next !== null && !isValidTimeZone(next)) throw new Error(`Unknown time zone: ${next}`);
    console.log(`[stage-controller] setTimezone -> ${scrub(next ?? "follow host")} (host is ${scrub(hostTimeZone())})`);
    setAppTimeZone(next);
    this.state = { ...this.state, timezone: next, hostTimezone: hostTimeZone() };
    await settingsStore.patch({ timezone: next });
    this.broadcast();
    return this.state;
  }

  /**
   * Set how the app displays a time of day.
   *
   * Display only. Nothing the server decides by the clock reads this — 8pm and
   * 20:00 are the same instant, and a schedule that changed with a display
   * preference would be a bug, not a feature.
   */
  async setHourCycle(cycle: "12h" | "24h"): Promise<StageState> {
    if (cycle !== "12h" && cycle !== "24h") throw new Error(`Unknown hour cycle: ${String(cycle)}`);
    this.state = { ...this.state, hourCycle: cycle };
    await settingsStore.patch({ hourCycle: cycle });
    this.broadcast();
    return this.state;
  }

  /** Recompute the upcoming rehearsal/service windows (from PCO) that gate the
   *  integration reconnect cadence. Cheap (cached PCO calls); runs on refresh +
   *  when creds/allowed/schedule change. Never throws. */
  async refreshServiceWindows(): Promise<void> {
    if (!this.pcoAppId || !this.pcoSecret) { serviceWindow.setWindows([]); return; }
    const { leadMin, tailMin } = this.state.reconnectSchedule;
    const leadMs = leadMin * 60_000, tailMs = tailMin * 60_000;
    try {
      const allTypes = await pcoService.listServiceTypes(this.pcoAppId, this.pcoSecret);
      const allowed = this.state.allowedServiceTypeIds;
      const types = allowed.length ? allTypes.filter((t) => allowed.includes(t.id)) : allTypes;
      const windows: { open: number; close: number }[] = [];
      for (const t of types) {
        const plans = await pcoService.listUpcomingPlans(this.pcoAppId, this.pcoSecret, t.id).catch(() => [] as PlanDTO[]);
        for (const p of plans.slice(0, 2)) { // next couple plans per type is plenty
          const times = await pcoService.listPlanTimes(this.pcoAppId, this.pcoSecret, t.id, p.id).catch(() => []);
          const starts = times.map((x) => Date.parse(x.startsAt)).filter(Number.isFinite);
          if (!starts.length) continue;
          const ends = times.map((x) => (x.endsAt ? Date.parse(x.endsAt) : NaN)).filter(Number.isFinite);
          windows.push({ open: Math.min(...starts) - leadMs, close: (ends.length ? Math.max(...ends) : Math.max(...starts)) + tailMs });
        }
      }
      serviceWindow.setWindows(windows);
      console.log(`[stage-controller] reconnect windows recomputed: ${scrub(windows.length)}`);
    } catch (err) {
      console.warn("[stage-controller] refreshServiceWindows failed:", err instanceof Error ? err.message : err);
    }
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
    // Once per available release, and only if somebody is connected to hear it.
    await announceIfNew(updater.getStatus());
      if (this.shouldAutoApply(status.behind, new Date())) {
        console.log("[stage-controller] auto-update window — applying update");
        // auto-install applies the build but leaves the restart to the operator,
        // so an update can land on Saturday and be taken on Monday.
        await updater.applyUpdate({ deferRestart: this.state.autoUpdate.mode === "auto-install" });
      }
    } catch (err) {
      console.error("[stage-controller] update check failed:", err);
    }
  }

  /** Auto-apply gate: enabled + something to pull + inside the scheduled
   *  day/hour window + not mid-service. Exposed for unit testing. */
  shouldAutoApply(behind: number, now: Date): boolean {
    const cfg = this.state.autoUpdate;
    if (cfg.mode === "manual" || behind <= 0) return false;
    if (updater.phase === "updating") return false;
    if (this.isServiceLive()) return false;
    // The APP's zone. On a UTC host "Monday 03:00" fires at 22:00 Sunday in
    // Chicago — i.e. an unattended restart in the middle of an evening service.
    const p = zonedParts(now.getTime());
    if (cfg.dayOfWeek != null && p.weekday !== cfg.dayOfWeek) return false;
    return p.hour === cfg.hour;
  }

  // ── Branding (app name + logo) ────────────────────────────────────────

  /** Update branding. Any field may be omitted to leave it unchanged; pass
   *  `logo: null` to clear the logo. The original image + crop transform are
   *  persisted to settings only (not broadcast) so the editor can retain zoom. */
  async setBranding(partial: {
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
  }): Promise<StageState> {
    // Fields that live in both the broadcast state and settings.
    const stateNext: Partial<Pick<StageState, "appName" | "accentColor" | "appLogo" | "appLogoMonochrome" | "emptySlotLogo" | "defaultAvatar">> = {};
    if (typeof partial.name === "string") stateNext.appName = partial.name.trim() || "Stage Utility";
    if (partial.accentColor !== undefined) stateNext.accentColor = partial.accentColor;
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

  /**
   * The slots an arrangement should capture for a view.
   *
   * A slots-kind View keeps its slots under its own id. A CUSTOM view does not:
   * its slots belong to inline `slots-grid` layout objects and are keyed by object
   * id, so looking it up by view id finds nothing. Resolved here only when the
   * view has exactly one such grid — with several, "the view's slots" has no one
   * meaning and the caller should be saving from the grid's own editor, which
   * sends its slots directly.
   */
  private slotsForPresetTarget(viewId: string): Slot[] {
    const own = this.rawSlotsByView.get(viewId);
    if (own?.length) return own;

    const view = this.state.views.find((v) => v.id === viewId);
    if (view?.kind === "custom" && view.layout) {
      const gridIds: string[] = [];
      forEachInlineSlotsGrid([view], (oid) => gridIds.push(oid));
      if (gridIds.length === 1) return this.rawSlotsByObject.get(gridIds[0]) ?? [];
    }
    return [];
  }

  async savePreset(target: string, name: string): Promise<SlotPreset[]> {
    const viewId = this.viewIdForTarget(target);
    console.log(`[stage-controller] savePreset "${scrub(name)}" for view=${scrub(viewId)}`);
    const presets = await presetsStore.load();
    const rawSlots = this.slotsForPresetTarget(viewId);
    // REFUSE rather than save nothing. This used to be `?? []`, so a target with
    // no entry in rawSlotsByView — every custom view, whose slots live per layout
    // object — silently produced an empty arrangement, saved and toasted as a
    // success. An arrangement that captures nothing is never what was meant.
    if (rawSlots.length === 0) {
      throw new Error(
        `Nothing to save: view ${viewId} has no slots. An arrangement captures a view's current slots.`,
      );
    }
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

  /**
   * Apply a saved arrangement to a view.
   *
   * Returns the view it actually wrote to, not just the new state. The caller
   * reads the applied slots back by that id: assuming it matched the id passed in
   * is what let a misdirected apply look like a success — nine slots written to
   * another view, and a toast saying "Arrangement applied".
   */
  async applyPreset(target: string, id: string): Promise<{ state: StageState; viewId: string }> {
    const viewId = this.viewIdForTarget(target);
    const presets = await presetsStore.load();
    const preset = presets.find((p) => p.id === id);
    if (!preset) throw new Error(`Preset ${id} not found`);

    // Refuse rather than write somewhere nothing reads. A custom view's slots live
    // per layout object, and a view that owns no slots at all (one embedding
    // another view's grid) can never show what we would write here.
    const view = this.state.views.find((v) => v.id === viewId);
    if (view && view.kind !== "slots") {
      throw new Error(
        `"${view.name}" is a ${view.kind} view and has no slots of its own. ` +
          "Recall the arrangement on the Mic Slots view it shows instead.",
      );
    }

    console.log(`[stage-controller] applyPreset "${scrub(preset.name)}" (${scrub(id)}) for view=${scrub(viewId)}`);

    // Deep-clone with fresh slot ids so applied slots are independent of the preset.
    const slots: Slot[] = preset.slots.map((s) => ({ ...s, id: randomUUID() }));
    const state = await this.setViewSlots(viewId, slots);
    return { state, viewId };
  }

  async deletePreset(id: string): Promise<SlotPreset[]> {
    console.log(`[stage-controller] deletePreset ${scrub(id)}`);
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
    console.log(`[stage-controller] importPreset "${scrub(newPreset.name)}" (${scrub(newPreset.slots.length)} slots)`);
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
    console.log(`[stage-controller] reorderPresets → ${scrub(reordered.map((p) => p.id).join(", "))}`);
    await presetsStore.save(reordered);
    return reordered;
  }

  async renamePreset(id: string, name: string): Promise<SlotPreset[]> {
    const presets = await presetsStore.load();
    const trimmed = name.trim();
    if (!trimmed) return presets;
    console.log(`[stage-controller] renamePreset ${scrub(id)} → "${scrub(trimmed)}"`);
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
    console.log(`[stage-controller] overwritePreset ${scrub(id)} (${scrub(rawSlots.length)} slots)`);
    const updated = presets.map((p) =>
      p.id === id ? { ...p, slots: rawSlots.map((s) => ({ ...s, id: randomUUID() })) } : p,
    );
    await presetsStore.save(updated);
    return updated;
  }

  // ── Views (content) ─────────────────────────────────────────────────

  getViews(): View[] {
    return [...this.state.views];
  }

  async createView(
    name: string,
    kind: ViewKind = "slots",
    surface: ViewSurface = "display",
  ): Promise<StageState> {
    const id = await this.allocateViewId();
    // Only a custom View has an editable layout, so only a custom View has
    // anywhere to put a control. Anything else asked for as a console would be
    // a console that cannot carry one - a promise the UI could not keep.
    const effectiveSurface: ViewSurface = kind === "custom" ? surface : "display";
    const view: View = {
      id,
      name: name?.trim() || defaultViewName(kind),
      kind,
      surface: effectiveSurface,
      ndiSource: null,
      createdAt: new Date().toISOString(),
      layout: kind === "custom" ? defaultCustomLayout() : null,
    };
    console.log(`[stage-controller] createView id=${scrub(id)} name="${scrub(view.name)}" kind=${scrub(kind)}`);
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
    console.log(`[stage-controller] renameView id=${scrub(id)} name="${scrub(trimmed)}"`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Change a View's kind (used by the legacy /api/displays kind alias). */
  /**
   * Change what a View is for.
   *
   * Converting a View that is currently bound REFUSES, naming the screens it
   * drives, rather than silently unbinding them. Silently unbinding is how an
   * operator discovers on Sunday morning that a screen went blank on Thursday.
   */
  async setViewSurface(id: string, surface: ViewSurface): Promise<StageState> {
    const view = this.state.views.find((v) => v.id === id);
    if (!view) throw new Error(`views:setSurface — view ${id} not found`);

    if (surface === "console") {
      // Every display-mode screen showing this View would become an invalid
      // binding the moment it turned into a console.
      const stranded = this.state.outputs.filter(
        (o) => o.viewId === id && outputMode(o) !== "panel",
      );
      if (stranded.length > 0) {
        const names = stranded.map((o) => o.name || o.id).join(", ");
        throw new Error(
          `"${view.name}" is showing on ${names}. ` +
            `Open ${stranded.length === 1 ? "that screen's" : "those screens'"} menu and choose "Use as a control surface" first, ` +
            `or point ${stranded.length === 1 ? "it" : "them"} at a different view.`,
        );
      }
    }

    const views = this.state.views.map((v) => (v.id === id ? { ...v, surface } : v));
    console.log(`[stage-controller] setViewSurface view=${scrub(id)} → ${scrub(surface)}`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  async setViewKind(id: string, kind: ViewKind): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setKind — view ${id} not found`);
    }
    const views = this.state.views.map((v) =>
      v.id === id
        ? { ...v, kind, layout: kind === "custom" ? (v.layout ?? defaultCustomLayout()) : v.layout }
        : v,
    );
    console.log(`[stage-controller] setViewKind id=${scrub(id)} kind=${scrub(kind)}`);
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
    console.log(`[stage-controller] setViewNdiSource id=${scrub(id)} source=${scrub(ndiSource ?? "(none)")}`);
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
    console.log(`[stage-controller] setViewSlotsLayout id=${scrub(id)} ${slotsLayout ? `${scrub(slotsLayout.displayWidthIn)}in` : "(off)"}`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /** Pick which saved ScriptView column preset a "script" View renders. */
  async setViewScriptViewLayout(id: string, scriptViewLayoutId: string | null): Promise<StageState> {
    if (!this.state.views.find((v) => v.id === id)) {
      throw new Error(`views:setScriptViewLayout — view ${id} not found`);
    }
    // Refused rather than stored: an unknown id renders as ALL columns, which
    // looks like a working display showing the wrong thing. Failing the write is
    // the only outcome the operator can act on.
    if (scriptViewLayoutId) {
      const known = await scriptViewLayoutsStore.load();
      if (!known.some((l) => l.id === scriptViewLayoutId)) {
        throw new Error(`views:setScriptViewLayout — no ScriptView layout ${scriptViewLayoutId}`);
      }
    }
    const views = this.state.views.map((v) => (v.id === id ? { ...v, scriptViewLayoutId } : v));
    console.log(`[stage-controller] setViewScriptViewLayout id=${scrub(id)} → ${scrub(scriptViewLayoutId)}`);
    this.state = { ...this.state, views };
    await viewsStore.save(views);
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /**
   * Replace a custom View's layout (visual editor save).
   *
   * `expectedRev` is the revision the editor opened. When it no longer matches,
   * someone else has saved this view in the meantime and this save would erase
   * their work, so it is REFUSED and the caller decides. Omitting it forces the
   * save through — that is the deliberate "overwrite anyway" path.
   */
  async setViewLayout(id: string, layout: LayoutDTO, expectedRev?: number): Promise<StageState> {
    const current = this.state.views.find((v) => v.id === id);
    if (!current) {
      throw new Error(`views:setLayout — view ${id} not found`);
    }
    const rev = current.layoutRev ?? 0;
    if (expectedRev !== undefined && expectedRev !== rev) {
      throw new LayoutConflictError(id, expectedRev, rev);
    }
    const views = this.state.views.map((v) => (v.id === id ? { ...v, layout, layoutRev: rev + 1 } : v));
    const objectCount = Array.isArray(layout.objects) ? layout.objects.length : 0;
    console.log(`[stage-controller] setViewLayout id=${scrub(id)} (${scrub(objectCount)} objects) rev=${scrub(rev + 1)}`);
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
    const newId = await this.allocateViewId();
    // Deep-clone the layout, recording old→new object ids so inline mic-slots can
    // be carried over to the copy.
    const cloned = src.layout ? cloneLayoutWithMap(src.layout) : null;
    // SPREAD the source, then override only what must differ. Listing the
    // fields to keep is how this silently dropped `surface`, `slotsLayout` and
    // `scriptViewLayoutId` — a duplicated console became a display, its buttons
    // rendering and doing nothing. A list of what to keep goes stale every time
    // View grows a field; a list of what to change does not.
    const copy: View = {
      ...src,
      id: newId,
      name: name?.trim() || `${src.name} copy`,
      ndiSource: src.ndiSource ?? null,
      createdAt: new Date().toISOString(),
      layout: cloned?.layout ?? null,
      // Deliberately NOT inherited: it is an optimistic-concurrency token, and a
      // fresh view starts at its own revision. Carrying the source's would make
      // the next save compare against a number that means nothing here.
      layoutRev: undefined,
    };
    console.log(`[stage-controller] duplicateView ${scrub(id)} → ${scrub(newId)} "${scrub(copy.name)}"`);
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
    // Home does not count. It is seeded on every install and invisible in every
    // list, so counting it turned "you cannot delete your last view" into "you
    // cannot delete Home" — a fresh install reads as 2 views, and deleting the
    // real one left the operator with nothing and an empty Screens page.
    if (screensListViews(this.state.views).length <= 1) {
      throw new Error("views:delete — cannot remove the last view");
    }
    console.log(`[stage-controller] deleteView id=${scrub(id)}`);
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
      // And any notes/checklist content those objects held. Same reason the
      // inline slots above are cleaned up: content is keyed by object id, and
      // without this notes.json accumulates the text of every object ever
      // deleted — carried into every backup, forever.
      const objectIds: string[] = [];
      const collect = (list: readonly LayoutObject[] | undefined) => {
        for (const o of list ?? []) {
          objectIds.push(o.id);
          collect(o.children);
        }
      };
      collect(removed.layout?.objects);
      if (objectIds.length > 0) {
        await notesStore.forget(objectIds);
        this.state = { ...this.state, notesByObject: notesStore.all() };
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
    console.log(`[stage-controller] reorderViews → ${scrub(reordered.map((v) => v.id).join(", "))}`);
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

  /**
   * Returns the created output as well as the state.
   *
   * Reading `state.outputs[state.outputs.length - 1]` after this resolves is NOT
   * a way to find it: `this.state` is mutated synchronously but read back after
   * an await, so two concurrent adds each see the later one. Two devices then
   * claim the same screen and the second silently displaces the first.
   */
  async addOutput(
    name?: string,
    viewId?: string | null,
  ): Promise<{ state: StageState; output: Output }> {
    // One write: the id, the floor that stops it ever coming back, and the
    // outputs list that could not be built until the id existed. The whole
    // read-allocate-write happens inside the settings write queue, so two
    // concurrent adds cannot be handed the same id.
    const { output, outputs } = await settingsStore.allocateIds(
      "output",
      (next): { output: Output; outputs: Output[] } => {
        const id = next(this.state.outputs.map((o) => o.id));
        const num = parseInt(id.replace("display-", ""), 10);
        const created: Output = {
          id,
          name: name?.trim() || `Display ${Number.isFinite(num) ? num : this.state.outputs.length + 1}`,
          viewId: viewId ?? null,
        };
        return { output: created, outputs: [...this.state.outputs, created] };
      },
      (allocated) => ({ outputs: allocated.outputs }),
    );
    console.log(`[stage-controller] addOutput id=${scrub(output.id)} name="${scrub(output.name)}" viewId=${scrub(output.viewId ?? "(none)")}`);
    this.state = { ...this.state, outputs };
    this.recomputeResolved();
    this.broadcast();
    return { state: this.state, output };
  }

  async renameOutput(id: string, name: string): Promise<StageState> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("outputs:rename — name must be non-empty");
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:rename — output ${id} not found`);
    }
    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, name: trimmed } : o));
    console.log(`[stage-controller] renameOutput id=${scrub(id)} name="${scrub(trimmed)}"`);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /**
   * Set (or clear, with "") an output's optional friendly URL slug.
   *
   * The id is never touched — `/{id}` keeps resolving forever, so a Pi or printed
   * QR pointed at it cannot break, and nothing is rekeyed so slots stay intact.
   * Validation is authoritative here rather than in the UI: a slug that collides
   * with a built-in page would not error at request time, it would silently render
   * that page instead of the display.
   */
  async setOutputSlug(id: string, slug: string): Promise<StageState> {
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:slug — output ${id} not found`);
    }
    const trimmed = slug.trim().toLowerCase();

    // Every id and slug in use EXCEPT this output's own, or re-saving would reject
    // its existing slug.
    const taken: string[] = [];
    for (const o of this.state.outputs) {
      if (o.id !== id) taken.push(o.id);
      if (o.slug && o.id !== id) taken.push(o.slug);
    }
    const verdict = validateSlug(trimmed, taken);
    if (!verdict.ok) throw new Error(verdict.reason);

    const outputs = this.state.outputs.map((o) =>
      o.id === id ? { ...o, slug: trimmed === "" ? undefined : trimmed } : o,
    );
    console.log(`[stage-controller] setOutputSlug id=${scrub(id)} slug="${scrub(trimmed)}"`);
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
    // Same reasoning as the console/wall check below: the picker no longer
    // offers Home, but an API call or a restored config still can. Home has no
    // geometry — it is a stack of cards sized for a browser column, edited in
    // its own tab — so on a wall screen it would render as exactly that.
    if (viewId === HOME_VIEW_ID) {
      throw new Error(
        `"Home" is the operator's front page, not a screen. Make a view for this screen instead.`,
      );
    }
    // THE safety property, and it lives here rather than in the settings
    // dropdown: a dropdown that only offers bindable views makes the mistake
    // hard to reach, but an API call, a Companion button or a restored config
    // can still ask for it. A wall screen must not be able to render a live
    // control at all.
    if (viewId !== null) {
      const view = this.state.views.find((v) => v.id === viewId)!;
      const output = this.state.outputs.find((o) => o.id === id)!;
      if (viewSurface(view) === "console" && outputMode(output) !== "panel") {
        throw new Error(
          `"${view.name}" has live controls, so it can only go on a control surface. ` +
            `"${output.name}" is a wall screen — open its menu and choose "Use as a control surface" first.`,
        );
      }
    }
    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, viewId } : o));
    console.log(`[stage-controller] setOutputView output=${scrub(id)} → view=${scrub(viewId ?? "(none)")}`);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /**
   * Make a screen a read-only display or an interactive control surface.
   *
   * Demoting a panel that currently shows a console is refused rather than
   * silently unbinding it: the operator would be left with a screen showing
   * nothing and no indication why.
   */
  async setOutputMode(id: string, mode: OutputMode): Promise<StageState> {
    const output = this.state.outputs.find((o) => o.id === id);
    if (!output) throw new Error(`outputs:setMode — output ${id} not found`);

    if (mode === "display" && output.viewId) {
      const view = this.state.views.find((v) => v.id === output.viewId);
      if (view && viewSurface(view) === "console") {
        throw new Error(
          `"${output.name}" is showing the control surface "${view.name}". ` +
            `Point it at a wall-screen view first, or it would be left showing nothing.`,
        );
      }
    }

    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, mode } : o));
    console.log(`[stage-controller] setOutputMode output=${scrub(id)} → ${scrub(mode)}`);
    this.state = { ...this.state, outputs };
    await settingsStore.patch({ outputs });
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  /**
   * Save what an operator typed into a notes/checklist object.
   *
   * Awaited before broadcasting: "it looked saved until the next restart" is a
   * failure this repository has already had with a config write, and this is
   * somebody's pre-service checklist.
   */
  async setNotes(objectId: string, content: NotesContent): Promise<StageState> {
    await notesStore.set(objectId, content);
    this.state = { ...this.state, notesByObject: notesStore.all() };
    this.broadcast();
    return this.state;
  }

  /** Set which context-bar items appear, and in what order. Global config. */
  async setBarItems(items: string[]): Promise<StageState> {
    const saved = await barConfigStore.set(items);
    this.state = { ...this.state, barItems: saved.items };
    this.broadcast();
    return this.state;
  }

  /** Keep a colour, or forget one. Global config, like the bar — see the store. */
  async setSavedColor(color: string, keep: boolean): Promise<StageState> {
    const colors = keep ? (await savedColorsStore.add(color)).colors : await savedColorsStore.remove(color);
    this.state = { ...this.state, savedColors: colors };
    this.broadcast();
    return this.state;
  }

  /** Toggle (or set) a full black blackout on an output, independent of its View. */
  async setOutputBlackout(id: string, blackout: boolean): Promise<StageState> {
    if (!this.state.outputs.find((o) => o.id === id)) {
      throw new Error(`outputs:setBlackout — output ${id} not found`);
    }
    const outputs = this.state.outputs.map((o) => (o.id === id ? { ...o, blackout } : o));
    console.log(`[stage-controller] setOutputBlackout output=${scrub(id)} → ${scrub(blackout ? "ON" : "off")}`);
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
    console.log(`[stage-controller] setOutputLocked output=${scrub(id)} → ${scrub(locked ? "LOCKED" : "unlocked")}`);
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
    console.log(`[stage-controller] reorderOutputs → ${scrub(reordered.map((o) => o.id).join(", "))}`);
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
    console.log(`[stage-controller] removeOutput id=${scrub(id)}`);
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






  // ── Refresh ───────────────────────────────────────────────────────────

  /**
   * Re-read views from disk into the in-memory state, and broadcast.
   *
   * For a writer that legitimately bypasses this controller — the view importer
   * merges a bundle into several stores at once, which is not a shape any
   * controller method has. Without this the file on disk is right and every open
   * page still shows the old list, because `broadcast()` sends `this.state`.
   */
  async reloadViews(): Promise<StageState> {
    const views = await viewsStore.load();
    this.state = { ...this.state, views };
    // Slot rows for a slots-KIND view. recomputeResolved reads rawSlotsByView,
    // so without this an imported slots view resolves to nothing though its rows
    // are on disk. duplicateView does this; the first version of reloadViews did
    // not, and export is offered for every view kind.
    if (this.state.serviceTypeId) {
      for (const v of views) {
        if (v.kind === "slots" && !this.rawSlotsByView.has(v.id)) {
          this.rawSlotsByView.set(v.id, await slotsStore.getSlots(v.id, this.state.serviceTypeId));
        }
      }
    }
    // Same inline-slots sync saveViewLayout does: an imported layout may contain
    // slots-grid objects whose rows are on disk but not yet in memory.
    const inlineIds = new Set<string>();
    forEachInlineSlotsGrid(this.state.views, (oid) => inlineIds.add(oid));
    if (this.state.serviceTypeId) {
      for (const oid of inlineIds) {
        if (!this.rawSlotsByObject.has(oid)) {
          this.rawSlotsByObject.set(oid, await slotsStore.getSlots(oid, this.state.serviceTypeId));
        }
      }
    }
    this.recomputeResolved();
    this.broadcast();
    return this.state;
  }

  async refresh(full = true): Promise<StageState> {
    console.log(`[stage-controller] refresh (${scrub(full ? "full" : "targeted")})`);
    // Manual "Refresh now" (full) drops the whole cache for a clean re-pull. The
    // unattended periodic tick only invalidates the active plan, so static
    // metadata (service types, note categories, team positions, other plans'
    // service times) stays cached instead of being re-fetched every interval.
    if (full) pcoService.clearCache();
    else if (this.state.planId) pcoService.clearPlanCache(this.state.planId);

    void this.refreshServiceWindows(); // keep reconnect windows current with PCO

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
    console.log(`[stage-controller] auto-refresh every ${scrub(Math.round(intervalMs / 60000))} min`);
    this.autoRefreshIntervalMs = intervalMs;
    this.autoRefreshTimer = setInterval(() => {
      void this.autoRefreshTick();
    }, intervalMs);
    // The roster timer ticks at a fixed cadence but only does work inside a
    // service window, so it costs nothing the rest of the week (see
    // rosterRefreshTick).
    this.rosterRefreshTimer = setInterval(() => {
      // The process boundary, where autoRefreshTick and updateCheckTick also
      // report and continue. There is no caller to hand a failure back to, and an
      // unhandled rejection out of a timer would take the server down mid-service.
      // The roster read itself already reports its own failure and keeps the
      // last-known names on screen rather than blanking them.
      void this.rosterRefreshTick().catch((err) => {
        console.error("[stage-controller] roster refresh failed:", err);
      });
    }, ROSTER_WINDOW_INTERVAL_MS);
  }

  /**
   * Quiet this controller's periodic writers, and hand back the undo.
   *
   * A config restore has to stop everything that writes config before it lays
   * the snapshot down, or the live poller's next tick reads a still-warm cache
   * and writes it back over the file just restored. Stopping was the easy half;
   * a restore that then FAILED left the box serving with nothing polling PCO —
   * displays frozen, recorders never ticking again, and no way back but a
   * restart. On success nothing calls the undo, because the process exits.
   *
   * Restores exactly what was running: the interval is whatever
   * integration-manager last chose, not the default, and neither timer is
   * started if it was not going in the first place.
   */
  pauseBackgroundWork(): () => void {
    const refreshMs = this.autoRefreshTimer ? this.autoRefreshIntervalMs : null;
    const hadUpdateChecks = this.updateCheckTimer !== null;
    this.stopAutoRefresh();
    this.stopUpdateChecks();
    return () => {
      if (refreshMs != null) this.startAutoRefresh(refreshMs);
      if (hadUpdateChecks) this.startUpdateChecks();
    };
  }

  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    if (this.rosterRefreshTimer) {
      clearInterval(this.rosterRefreshTimer);
      this.rosterRefreshTimer = null;
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

  /**
   * Re-pull JUST the roster, and only while a service window is open.
   *
   * The roster was the stalest thing the app showed. It moved only on the plan
   * refresh, which an operator may have set to two hours — so a last-minute
   * substitution could take two hours to reach a stage display, and the display is
   * the whole reason the name is there. Everything else the app reads from PCO is
   * either cached in minutes or, for the live timer, not cached at all.
   *
   * Gated on `serviceWindow`, the app's ONE definition of "near a service": PCO
   * plan times widened by the operator's configured lead and tail. Deliberately
   * not a second definition. It compares instants against plan times, so there is
   * no calendar-date or hour-of-day question and no host-vs-app-time-zone trap.
   *
   * It ignores `reconnectSchedule.enabled`, which governs integration reconnect
   * back-off rather than how fresh PCO data is. Turning that switch off does not
   * stale the roster back out; the lead and tail under it still shape the window.
   *
   * Outside a window this returns having made no request, so the cost away from a
   * service is one no-op timer callback a minute and zero PCO traffic. That also
   * means it fails CLOSED where the window set is unknown (no credentials, or a
   * failed schedule fetch): the roster then moves on the operator's configured
   * interval, exactly as it did before this existed.
   */
  private async rosterRefreshTick(): Promise<void> {
    if (!serviceWindow.isActive()) return;
    // A full refresh is already re-pulling the roster, and a previous tick may
    // still be in flight — listTeamMembers paginates and backs off on a 429, so a
    // slow window can outlast the 60s cadence. Either way, two writers racing over
    // this.teamMembers is what we are avoiding.
    if (this.isRefreshing || this.rosterRefreshing) return;
    if (!this.state.pcoConfigured || !this.pcoAppId || !this.pcoSecret) return;
    const { serviceTypeId, planId } = this.state;
    if (!serviceTypeId || !planId) return;

    this.rosterRefreshing = true;
    try {
      const before = JSON.stringify(this.teamMembers);
      await this.fetchTeamMembers(serviceTypeId, planId, { fresh: true });
      if (JSON.stringify(this.teamMembers) === before) return;
      // broadcast() already drops an identical state, so the saving here is
      // recomputeResolved(), which re-resolves every view, every inline slots grid
      // and every view-sourced grid. That runs every minute for hours inside a
      // window, and almost every one of those minutes the roster has not changed.
      console.log("[stage-controller] roster changed mid-window — re-resolving");
      this.recomputeResolved();
      this.broadcast();
    } finally {
      this.rosterRefreshing = false;
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
      // Skip the expensive re-resolve + full-state broadcast when nothing is
      // consuming it (idle). Mark dirty so the next connecting client gets fresh
      // state via ensureResolvedFresh() before hydration.
      //
      // channelInDemand, not channelHasSubscribers: "slots:devices" is the channel
      // the wireless.battery-below and wireless.rf-below triggers read, and the
      // automation engine reads it in-process where no SSE check can see it. Asking
      // only about browsers meant those two rules could never fire on an unattended
      // box — the state an appliance is in for most of the week.
      if (
        channelInDemand("stage:state-changed") ||
        channelInDemand("slots:devices") ||
        channelInDemand(WIRELESS_STATUS_CHANNEL)
      ) {
        this.recomputeResolved();
        this.broadcastDevices();
        this.broadcastWirelessChannels();
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

  /**
   * Every wireless RF channel's live telemetry, for the wireless widgets.
   *
   * They used to read `/api/integrations/wireless/channels`, which returns
   * `{id, label}` for a picker — no battery, no RF, no `channelId`. The hook
   * declared the result as `DeviceStatus[]` and nothing complained, so
   * `d.online` was undefined on every row: the summary counted zero of N online
   * for good, and a channel tile that had been given a channel found no match
   * and drew a dash. Both widgets shipped reading fields the endpoint has never
   * sent.
   *
   * Chargers are excluded. A bay is not a mic: an empty one would drag "lowest
   * battery" to zero and cry wolf, and a shelf of docked spares would pad the
   * online count. `charger-battery` is the widget for those.
   */
  wirelessChannelStatuses(): DeviceStatus[] {
    return [...this.deviceStatuses.values()]
      .filter((d) => d.deviceType !== "charger")
      .sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  /**
   * Push wireless telemetry, on change and only while a browser is watching.
   *
   * Deliberately `channelHasSubscribers` and not `channelInDemand`, unlike the
   * gate in applyDeviceStatus that reaches this: nothing in-process reads
   * "wireless:channels". Automation's wireless triggers read "slots:devices", so
   * a rule keeps THAT flowing without also paying for a channel only the wireless
   * widgets render.
   */
  private broadcastWirelessChannels(): void {
    if (!channelHasSubscribers(WIRELESS_STATUS_CHANNEL)) return;
    const channels = this.wirelessChannelStatuses();
    // `updatedAt` moves on every sample even when nothing an operator can see
    // did, so it is excluded from the comparison — otherwise "broadcast on
    // change" would broadcast several times a second, for ever.
    const sig = JSON.stringify(channels.map(({ updatedAt: _updatedAt, ...rest }) => rest));
    if (sig === this.lastWirelessSig) return;
    this.lastWirelessSig = sig;
    broadcast(WIRELESS_STATUS_CHANNEL, channels);
  }

  private lastWirelessSig: string | null = null;

  /** Cancel any pending coalesced device-status broadcast (used on shutdown). */
  stopDeviceStatusUpdates(): void {
    if (this.deviceStatusFlushTimer === null) return;
    clearTimeout(this.deviceStatusFlushTimer);
    this.deviceStatusFlushTimer = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────

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
  /**
   * Resolve a caller's target to a view id.
   *
   * VIEWS WIN. Output ids and view ids live in one namespace and can collide —
   * an install with an output `display-2` routed to view `view-2`, plus a view
   * also called `display-2`, is not hypothetical: it is what shipped. Resolving
   * outputs first meant the Views page asking for view `display-2` silently got
   * `view-2`, so recalling an arrangement wrote nine slots into a different view
   * and reported success. Nineteen times, in one log.
   *
   * Every modern caller passes a view id. Output resolution stays for the legacy
   * output-shaped callers, but only when nothing owns that id as a view.
   */
  private viewIdForTarget(target: string): string {
    if (!target) return this.primaryViewId();
    const view = this.state.views.find((v) => v.id === target);
    const output = this.state.outputs.find((o) => o.id === target);
    if (view) {
      // Ambiguity is never silent: it is exactly the condition that hid this bug.
      if (output && output.viewId && output.viewId !== target) {
        console.warn(
          `[stage-controller] target "${scrub(target)}" names both a view and an output ` +
            `routed to "${scrub(output.viewId)}" — using the VIEW. Pass viewId to be explicit.`,
        );
      }
      return view.id;
    }
    if (output) return output.viewId ?? this.primaryViewId();
    return target; // already a view id, or an id we do not know
  }

  /**
   * Allocate a view id, recording the floor BEFORE the view exists.
   *
   * The floor lives in settings.json and views live in views.json, so there is
   * no save here to fold it into — it is its own write, and an AWAITED one. A
   * fire-and-forget floor that never reached disk would hand the same id out
   * again after a restart, which is the whole bug this exists to stop.
   *
   * Written first on purpose: if the floor write fails, nothing is created; if
   * the view save afterwards fails, the only cost is a number nobody used. Ids
   * are permanent, not contiguous.
   */
  private allocateViewId(): Promise<string> {
    return settingsStore.allocateIds("view", (next) => next(this.state.views.map((v) => v.id)));
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
      planDates: plan.dates,
    };
    await settingsStore.patch({
      planId: plan.id,
      planTitle: plan.title,
      planSeriesTitle: plan.seriesTitle,
      planDates: plan.dates,
    });

    if (this.state.serviceTypeId) {
      await this.fetchTeamMembers(this.state.serviceTypeId, plan.id);
    }

    await this.reResolveAll();
    this.state = { ...this.state, lastRefreshedAt: new Date().toISOString() };
    this.broadcast();
  }

  /**
   * @param opts.fresh drop this plan's cached roster first, so the read is a real
   * request. The in-window roster tick needs that: its cadence must be its own,
   * not an accident of whatever the cache TTL happens to be that release.
   */
  private async fetchTeamMembers(
    serviceTypeId: string,
    planId: string,
    opts: { fresh?: boolean } = {},
  ): Promise<void> {
    const key = `${serviceTypeId}:${planId}`;
    if (opts.fresh) pcoService.clearTeamMembersCache(this.pcoAppId!, serviceTypeId, planId);
    try {
      const fetched = await pcoService.listTeamMembers(
        this.pcoAppId!,
        this.pcoSecret!,
        serviceTypeId,
        planId,
      );
      // The plan can move WHILE this request is in flight — auto plan-mode rolls
      // from the 9am plan to the 11am one, and inside a service window the roster
      // tick is firing every minute, so the two overlap by design. Writing a
      // resolved-too-late roster here would put the previous service's names on
      // every stage display until the next tick. A stale success is discarded,
      // not applied.
      if (this.state.serviceTypeId !== serviceTypeId || this.state.planId !== planId) {
        console.log(
          `[stage-controller] discarding a roster for a plan that is no longer selected (${scrub(key)})`,
        );
        return;
      }
      this.teamMembers = fetched;
      this.teamMembersKey = key;
      console.log(`[stage-controller] fetched ${scrub(this.teamMembers.length)} team members`);
    } catch (err) {
      // Offline is not "nobody is scheduled". This used to clear the roster, and
      // the caller re-resolves every slot straight afterwards — so a 30-second
      // network blip during the hourly refresh blanked every name and photo on
      // every stage display at once, and left them blank until the next refresh
      // an hour later. Keep the last-known roster when it belongs to this same
      // plan; only a roster for some OTHER plan is worse than nothing.
      if (this.teamMembersKey === key && this.teamMembers.length > 0) {
        console.error(
          `[stage-controller] fetchTeamMembers failed — keeping ${this.teamMembers.length} known member(s):`,
          err,
        );
        return;
      }
      console.error("[stage-controller] fetchTeamMembers error:", err);
      this.teamMembers = [];
      this.teamMembersKey = null;
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
      // An inline grid is whatever size the operator dragged it to, so nothing
      // here knows the shape its photos will be drawn at. Send the whole image
      // and let `object-fit: cover` crop it in the one place that does. The view
      // path above keeps the column crop: a display's box genuinely IS that
      // shape. See AvatarFit.
      slotsByLayoutObject[oid] = resolveSlots(raw, this.teamMembers, this.deviceStatuses, "whole");
    };
    forEachInlineSlotsGrid(this.state.views, resolveObjectSlots);
    for (const oid of this.rawSlotsByObject.keys()) if (!(oid in slotsByLayoutObject)) resolveObjectSlots(oid);

    // A grid EMBEDDING a slots view is the same problem wearing a different
    // source. Its slots come from that view, but its box is a free-dragged
    // rectangle on a custom layout, so it needs the whole image exactly as an
    // inline grid does. Keyed by the OBJECT so the source view's own display
    // keeps the column crop it is correctly modelled on; the renderer reads this
    // first and falls back to slotsByView for anything not resolved here.
    forEachViewSourcedSlotsGrid(this.state.views, (oid, sourceViewId) => {
      const raw = this.rawSlotsByView.get(sourceViewId) ?? [];
      slotsByLayoutObject[oid] = resolveSlots(raw, this.teamMembers, this.deviceStatuses, "whole");
    });

    const resolvedByOutput: Record<string, ResolvedOutput> = {};
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
    }
    this.state = {
      ...this.state,
      slotsByView,
      slotsByLayoutObject,
      resolvedByOutput,
      chargerBays: this.computeChargerBays(),
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
  /**
   * Push only the volatile per-slot telemetry.
   *
   * RF and audio level move constantly while mics are live, and they live on the
   * slots inside stage:state — so a meter twitch used to re-send the whole 36.6 KB
   * document up to ~6.7 times a second, of which 88% (views, slot config, layouts,
   * outputs) had not changed. This sends the ~4.5 KB that did.
   *
   * `recomputeResolved()` has already refreshed `this.state`, so a client
   * connecting mid-service still hydrates complete — the two are consistent, this
   * is purely about not repeating the static half down the wire.
   */
  private broadcastDevices(): void {
    const devices: Record<string, SlotDevice> = {};
    for (const slots of Object.values(this.state.slotsByView)) {
      for (const s of slots) devices[s.id] = s.device;
    }
    for (const slots of Object.values(this.state.slotsByLayoutObject)) {
      for (const s of slots) devices[s.id] = s.device;
    }
    const sig = JSON.stringify(devices);
    if (sig === this.lastDeviceSig) return; // nothing actually moved
    this.lastDeviceSig = sig;
    broadcast("slots:devices", devices, sig);
  }

  private broadcast(): void {
    // Skip when nothing actually changed — a setter called with its current value
    // (same mode, unchanged settings save) still runs the mutating method. State is
    // change-driven and fires rarely, so a full-record delta protocol isn't worth its
    // client-merge risk; this dedupe removes the redundant full-state pushes cheaply.
    const sig = JSON.stringify(this.state);
    if (sig === this.lastBroadcastSig) return;
    this.lastBroadcastSig = sig;
    // Reuse the dedupe serialization as the SSE frame body so the fan-out doesn't
    // re-stringify the full state once per client.
    broadcast("stage:state-changed", this.state, sig);
  }
}

export const stageController = new StageController();
