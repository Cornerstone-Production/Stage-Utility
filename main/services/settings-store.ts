// Persists non-secret settings: service type/plan selection, planMode,
// integration configs (non-secret fields), display options.

import type { DisplayInfo, Output } from "../types/stage.js";
import { DataStore } from "./data-store.js";

export interface SettingsData {
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  planMode: "auto" | "manual";
  planId: string | null;
  planTitle: string | null;
  planSeriesTitle: string | null;
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
  /** Show NDI-related controls (source field, NDI video object). Off by default —
   *  NDI is only used by the native Apple client. */
  ndiEnabled: boolean;
}

const DEFAULT_SETTINGS: SettingsData = {
  serviceTypeId: null,
  serviceTypeName: null,
  planMode: "auto",
  planId: null,
  planTitle: null,
  planSeriesTitle: null,
  integrationConfigs: {},
  integrationEnabled: {},
  showQr: true,
  displays: [{ id: "display-1", name: "Display 1" }],
  allowedServiceTypeIds: ["41227", "61695", "75953", "249176"],
  wirelessMeterRateMs: 1000,
  appName: "Stage Utility",
  appLogo: null,
  appLogoMonochrome: true,
  appLogoOriginal: null,
  appLogoCrop: null,
  emptySlotLogo: null,
  emptySlotLogoOriginal: null,
  emptySlotLogoCrop: null,
  ndiEnabled: false,
};

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
    const current = await store.load();
    const updated = { ...current, ...partial };
    await store.save(updated);
    return updated;
  },
};
