// Persists non-secret settings: service type/plan selection, planMode,
// integration configs (non-secret fields), display options.

import type { BaptismAutoStart, DisplayInfo, Output } from "../types/stage.js";
import { setAppTimeZone } from "./app-timezone.js";
import { externalizeBrandingImages } from "./branding-image-store.js";
import { DataStore } from "./data-store.js";
import { ID_KINDS, initialFloor, nextId, type IdKind } from "./id-allocator.js";

export interface SettingsData {
  /** Whether and how the baptism timer starts itself from the plan. */
  baptismAutoStart?: BaptismAutoStart;
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  planMode: "auto" | "manual";
  planId: string | null;
  planTitle: string | null;
  planSeriesTitle: string | null;
  planDates?: string | null;
  backupSchedule?: import("./backup-scheduler.js").BackupSchedule;
  integrationConfigs: Record<string, Record<string, unknown>>;
  integrationEnabled: Record<string, boolean>;
  showQr: boolean;
  /** @deprecated Legacy per-display config. Read once during migration to seed
   *  `outputs` + views.json, then no longer the source of truth. */
  displays: DisplayInfo[];
  /** Physical screens + their View routing (canonical once migrated). */
  outputs?: Output[];
  /**
   * High-water marks for id allocation — the next number each kind may use.
   *
   * Persisted because a deleted item leaves no trace in the live list, and
   * `max(existing) + 1` therefore hands its id to the next thing created. Ids
   * are permanent by contract: slots.json is keyed by output id, and Pis,
   * bookmarks and QR codes point at `/<id>`.
   *
   * Absent means "not recorded yet", and the allocator falls back to the
   * collision check alone — so an install that upgrades into this keeps working
   * and starts recording from its current maximum.
   */
  idFloors?: { view?: number; output?: number };
  /** Allowlisted service type IDs for auto mode. Empty = all allowed. */
  allowedServiceTypeIds: string[];
  /** Polling/metering interval (ms) applied to all wireless gear. */
  wirelessMeterRateMs: number;
  /** Customizable brand name shown in the sidebar header and on the kiosk. */
  appName: string;
  /**
   * Kiosk device discovery — the UDP responder that lets a screen find this
   * server and be claimed.
   *
   * OFF until switched on, deliberately. A fresh install answering discovery
   * would let a test instance on the same LAN claim a screen meant for the real
   * one; turning it on is a decision somebody makes once, on the server that
   * runs the building.
   *
   * A device already bound to THIS server is answered either way — that is how a
   * display re-finds its server after an IP change, and gating it here would
   * leave a screen dark until somebody opened settings.
   */
  kioskDiscovery: boolean;
  /** Port for the discovery exchange. Adjustable because AV gear is fond of odd
   *  UDP ports and a collision should be a settings change, not a rebuild. */
  kioskDiscoveryPort: number;
  /** Stable per install; a device uses it to tell two servers apart. Generated
   *  on first use and never rewritten — every binding on every device refers to
   *  it, so changing it would orphan the lot. */
  serverId: string | null;
  /** Themeable brand accent as a #rrggbb hex, or null to use the built-in default. */
  accentColor: string | null;
  /** Rendered (cropped) brand logo as a data URL, shown everywhere. */
  appLogo: string | null;
  /** Recolor a single-color logo to match the theme (mask with currentColor). */
  appLogoMonochrome: boolean;
  /** Original uploaded image (settings-only; used to re-open the crop editor). */
  appLogoOriginal: string | null;
  /** Saved crop transform so re-editing retains zoom/position. */
  appLogoCrop: { scale: number; x: number; y: number } | null;
  /** Rendered (cropped) image centered in empty slots on the kiosk. */
  emptySlotLogo: string | null;
  /** Original upload + crop transform for the empty-slot image (settings-only). */
  emptySlotLogoOriginal: string | null;
  emptySlotLogoCrop: { scale: number; x: number; y: number } | null;
  /** Rendered (cropped) avatar shown for matched people with no PCO photo. */
  defaultAvatar: string | null;
  /** Original upload + crop transform for the default avatar (settings-only). */
  defaultAvatarOriginal: string | null;
  defaultAvatarCrop: { scale: number; x: number; y: number } | null;
  /** Show NDI-related controls (source field, NDI video object). Off by default —
   *  NDI is only used by the native Apple client.
   *
   *  Deliberately dormant on this branch, not dead: the NDI UI was removed from
   *  `main` while the schema stayed, so nothing in renderer/ reads this and the
   *  only writer is stageController.setNdiEnabled. It reads like an oversight and
   *  is not one — deleting it costs the migration path back when the Apple client
   *  lands. Same for a View's `ndiSource`, which layout-renderer and layout-editor
   *  still read. */
  ndiEnabled: boolean;
  /** Public base URL (e.g. a DNS name behind a reverse proxy) used for the connect
   *  QR code and display links instead of the LAN IP. Null = use the LAN IP. */
  publicUrl: string | null;
  iconColors?: Record<string, string>;
  iconGlyphs?: Record<string, string>;
  /** User-assigned caption colors, keyed by ProdCom channel label (channelName,
   *  or channelId when unnamed). Overrides the auto/ProdCom color. */
  captionChannelColors: Record<string, string>;
  /** Scheduled in-app auto-update window. */
  autoUpdate: { mode?: "manual" | "auto-install" | "auto-full"; enabled?: boolean; dayOfWeek: number | null; hour: number };
  /** Time-aware integration reconnect tunables (leadMin/tailMin/dormantMin). */
  reconnectSchedule?: { enabled: boolean; leadMin: number; tailMin: number; dormantMin: number };
  /** Attendance ramp/taper capture windows in minutes (preMin/postMin). */
  taperWindow?: { preMin: number; postMin: number };
  /** IANA zone every wall-clock decision is made in (schedules, day-of-week and
   *  time-of-day automation conditions, which day a service files under). Null =
   *  follow the host clock — fine on a machine set to local time, wrong on the
   *  UTC default most servers and containers ship with. */
  timezone?: string | null;
  /** How a time of DAY is displayed — "12h" or "24h". Display only: it changes
   *  nothing the server decides, because 12h and 24h are the same instant. */
  hourCycle?: "12h" | "24h";
  /** Local UDP port the OSC integration listens on for device feedback. */
  oscFeedbackPort: number;
  /** Smaart metric keys to surface in the SPL History tab (empty = auto default). */
  splVisibleMetrics: string[];
  /** Operator dismissed the first-run "Getting started" checklist (machine-wide). */
  onboardingDismissed: boolean;
  /**
   * The one-time strip of registry-written styling has run (see
   * never-chosen-defaults.ts).
   *
   * It has to be recorded, because the data cannot say it: a readout wearing
   * `textAlign: "center"` looks identical whether the registry wrote it at
   * creation or the operator chose it in the inspector. Running the strip on
   * every load therefore deleted the operator's choice every restart — reported
   * as widgets un-centring themselves after each update.
   *
   * Absent means never run, so an install that upgrades into this still gets its
   * one pass.
   */
  layoutDefaultsCleaned?: boolean;
  /**
   * Which of a plan's notes become the pre-service checklist.
   *
   * Names, not ids. A plan note carries `category_name` on its own attributes
   * and its teams by name, so matching on names costs no extra request — and a
   * category renamed in PCO SHOULD stop matching, because the operator renamed
   * the thing they were pointing at.
   *
   * Both empty means no checklist, not every note. See selectNotes in
   * plan-note-checklist.ts for why that direction is the safe one.
   */
  checklistNoteCategories?: string[];
  checklistNoteTeams?: string[];
}

export const DEFAULT_SETTINGS: SettingsData = {
  // Off until someone turns it on: a timer that starts itself unasked during a
  // service is worse than one that has to be started.
  baptismAutoStart: { enabled: false, testimonyKeyword: "baptism stories" },
  serviceTypeId: null,
  serviceTypeName: null,
  planMode: "auto",
  planId: null,
  planTitle: null,
  planSeriesTitle: null,
  planDates: null,
  integrationConfigs: {},
  integrationEnabled: {},
  showQr: true,
  displays: [{ id: "display-1", name: "Display 1" }],
  idFloors: {},
  // Empty, which every reader treats as "all allowed". Seeding it with ids
  // restricts a fresh install to service types that exist in no other org.
  allowedServiceTypeIds: [],
  wirelessMeterRateMs: 1000,
  appName: "Stage Utility",
  kioskDiscovery: false,
  kioskDiscoveryPort: 8789,
  serverId: null,
  accentColor: null,
  appLogo: null,
  appLogoMonochrome: true,
  appLogoOriginal: null,
  appLogoCrop: null,
  emptySlotLogo: null,
  emptySlotLogoOriginal: null,
  emptySlotLogoCrop: null,
  defaultAvatar: null,
  defaultAvatarOriginal: null,
  defaultAvatarCrop: null,
  ndiEnabled: false,
  publicUrl: null,
  iconColors: {},
  iconGlyphs: {},
  captionChannelColors: {},
  autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
  oscFeedbackPort: 9000,
  splVisibleMetrics: [],
  onboardingDismissed: false,
  checklistNoteCategories: [],
  checklistNoteTeams: [],
};

/** Default attendance capture windows (minutes). Shared by the recorder (fallback
 *  when unset) and the stage state the Advanced tab reads. */
export const DEFAULT_TAPER_WINDOW = { preMin: 60, postMin: 60 };

const store = new DataStore<SettingsData>("settings.json", DEFAULT_SETTINGS, "config");

/** Keep the process-wide zone in step with what was just read or written. Every
 *  path in and out of settings funnels through here so no caller can forget, and
 *  a sync `appTimeZone()` (automation conditions, schedules) is always current. */
function syncTimeZone(data: SettingsData): SettingsData {
  setAppTimeZone(data.timezone ?? null);
  return data;
}

export const settingsStore = {
  async load(): Promise<SettingsData> {
    return syncTimeZone(await store.load());
  },

  // There is deliberately no `save`. A whole-object write is a read-modify-write
  // that is not serialized against anything, so it undoes every field written
  // between the read and the write -- and one of those fields is idFloors, the
  // high-water mark that stops a deleted view or display id being reissued.
  // `patch` is a serialized read-modify-write and takes only the fields that
  // actually changed. Removed rather than documented so the type checker is what
  // stops the next caller.

  async get(): Promise<SettingsData> {
    return syncTimeZone(await store.load());
  },

  async patch(partial: Partial<SettingsData>): Promise<SettingsData> {
    // Images arrive as base64 data URLs from the branding editor. Store the bytes as
    // files and keep only the reference: inline they made settings.json 435 KB of
    // which 431 KB never changed, so patching one boolean re-serialised the lot —
    // and two of them ride in stage:state, where they were 77% of every broadcast.
    const clean = (await externalizeBrandingImages(partial as Record<string, unknown>)) as Partial<SettingsData>;
    // Serialized atomic read-modify-write — prevents a concurrent patch (e.g. the
    // live poller advancing the plan while the operator changes display routing)
    // from clobbering this one's fields.
    return syncTimeZone(await store.update((current) => ({ ...current, ...clean })));
  },

  /**
   * Allocate one or more ids AND advance the floor as one serialized
   * read-modify-write.
   *
   * Atomic by construction rather than by luck. Allocation reads a floor and
   * writes it back, and its callers await in between — so with a cold settings
   * cache two concurrent creates could both read the same floor and be handed
   * the same id. Doing the whole read-allocate-write inside `store.update` puts
   * it on the same write queue as every other settings write, which is the only
   * thing that makes the pair indivisible. Nothing else in the code states that
   * dependency, so it must not be left implicit.
   *
   * `allocate` runs INSIDE that queue and must therefore be SYNCHRONOUS —
   * awaiting in there would hold every other settings write for as long as it
   * took. It is handed a `next` it may call as many times as it needs (a view
   * bundle mints one id per imported view), each call passing the ids taken so
   * far so the collision check stays honest across the batch.
   *
   * `alsoWrite` turns what was allocated into settings fields to write in the
   * SAME file write — `addOutput`'s outputs list, which cannot be built until
   * the id exists. It must not produce branding-image fields: this path does not
   * externalize data URLs the way `patch` does.
   */
  async allocateIds<R>(
    kind: IdKind,
    allocate: (next: (existingIds: readonly string[]) => string) => R,
    alsoWrite: (allocated: R) => Partial<SettingsData> = () => ({}),
  ): Promise<R> {
    const { prefix, first } = ID_KINDS[kind];
    let allocated!: R;
    // Wrapped like every other write path, so the "no caller can forget"
    // invariant syncTimeZone documents stays literally true.
    syncTimeZone(await store.update((current) => {
      let floor = Math.max(current.idFloors?.[kind] ?? first, first);
      allocated = allocate((existingIds) => {
        const minted = nextId(prefix, existingIds, floor);
        floor = minted.nextFloor;
        return minted.id;
      });
      return {
        ...current,
        ...alsoWrite(allocated),
        // Monotonic against `current`, not against the floor read above: a floor
        // that went backwards is the id-reuse bug again.
        idFloors: { ...current.idFloors, [kind]: Math.max(current.idFloors?.[kind] ?? 0, floor) },
      };
    }));
    return allocated;
  },

  /**
   * Bring every floor up to at least one past the highest id on disk. Boot's
   * repair pass for a floor that is missing or too low.
   *
   * MISSING is the install that upgraded into id floors: nothing writes a floor
   * until an id is issued, so it has ids and no floor, and the fallback for a
   * missing floor is the collision check alone — `max(existing) + 1`, the
   * original bug.
   *
   * TOO LOW is anything that put ids on disk without going through the
   * allocator: a settings.json edited by hand, a data directory assembled by
   * copying files, an older build. A restore USED to be the main way in — a
   * pre-feature snapshot carries no floors, and the merge had only the live
   * floor to keep — but config-snapshot.ts now raises the floor past the ids in
   * the bundle as it writes, so the floor is correct before this ever runs. This
   * is the backstop, not the thing that closes that hole.
   *
   * RAISING, not overwriting, is what makes recomputing from the live list safe.
   * A stored floor knows about ids that were spent and then deleted, which the
   * live list cannot; taking the max keeps that knowledge and adds the ids the
   * floor did not know about. It can only ever move a floor up. (This used to
   * skip any floor that was present, on the reasoning that recomputing could
   * only lower it — true of an overwrite, and the reason a restore reissued ids.)
   */
  async seedIdFloors(seeds: Record<IdKind, readonly string[]>): Promise<void> {
    syncTimeZone(await store.update((current) => {
      const floors = { ...current.idFloors };
      let changed = false;
      for (const kind of Object.keys(seeds) as IdKind[]) {
        const raised = Math.max(floors[kind] ?? 0, initialFloor(kind, seeds[kind]));
        if (raised === floors[kind]) continue;
        floors[kind] = raised;
        changed = true;
      }
      // Reference-equal means "nothing changed", which DataStore.update honours
      // by not writing — so a normal boot costs no disk write.
      return changed ? { ...current, idFloors: floors } : current;
    }));
  },
};
