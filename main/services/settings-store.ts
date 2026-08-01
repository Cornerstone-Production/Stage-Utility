// Persists non-secret settings: service type/plan selection, planMode,
// integration configs (non-secret fields), display options.

import type { BaptismAutoStart, DisplayInfo, Output } from "../types/stage.js";
import { externalizeBrandingImages } from "./branding-image-store.js";
import { DataStore } from "./data-store.js";

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
  /** Allowlisted service type IDs for auto mode. Empty = all allowed. */
  allowedServiceTypeIds: string[];
  /** Polling/metering interval (ms) applied to all wireless gear. */
  wirelessMeterRateMs: number;
  /** Customizable brand name shown in the sidebar header and on the kiosk. */
  appName: string;
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
   *  NDI is only used by the native Apple client. */
  ndiEnabled: boolean;
  /** Public base URL (e.g. a DNS name behind a reverse proxy) used for the connect
   *  QR code and display links instead of the LAN IP. Null = use the LAN IP. */
  publicUrl: string | null;
  iconColors?: Record<string, string>;
  /** User-assigned caption colors, keyed by ProdCom channel label (channelName,
   *  or channelId when unnamed). Overrides the auto/ProdCom color. */
  captionChannelColors: Record<string, string>;
  /** Scheduled in-app auto-update window. */
  autoUpdate: { mode?: "manual" | "auto-install" | "auto-full"; enabled?: boolean; dayOfWeek: number | null; hour: number };
  /** Time-aware integration reconnect tunables (leadMin/tailMin/dormantMin). */
  reconnectSchedule?: { enabled: boolean; leadMin: number; tailMin: number; dormantMin: number };
  /** Attendance ramp/taper capture windows in minutes (preMin/postMin). */
  taperWindow?: { preMin: number; postMin: number };
  /** Local UDP port the OSC integration listens on for device feedback. */
  oscFeedbackPort: number;
  /** Smaart metric keys to surface in the SPL History tab (empty = auto default). */
  splVisibleMetrics: string[];
  /** Operator dismissed the first-run "Getting started" checklist (machine-wide). */
  onboardingDismissed: boolean;
}

const DEFAULT_SETTINGS: SettingsData = {
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
  allowedServiceTypeIds: ["41227", "61695", "75953", "249176"],
  wirelessMeterRateMs: 1000,
  appName: "Stage Utility",
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
  captionChannelColors: {},
  autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
  oscFeedbackPort: 9000,
  splVisibleMetrics: [],
  onboardingDismissed: false,
};

/** Default attendance capture windows (minutes). Shared by the recorder (fallback
 *  when unset) and the stage state the Advanced tab reads. */
export const DEFAULT_TAPER_WINDOW = { preMin: 60, postMin: 60 };

const store = new DataStore<SettingsData>("settings.json", DEFAULT_SETTINGS);

export const settingsStore = {
  async load(): Promise<SettingsData> {
    return store.load();
  },

  async save(data: SettingsData): Promise<void> {
    return store.save(data);
  },

  async get(): Promise<SettingsData> {
    return store.load();
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
    return store.update((current) => ({ ...current, ...clean }));
  },
};
