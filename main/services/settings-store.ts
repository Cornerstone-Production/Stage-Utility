// Persists non-secret settings: service type/plan selection, planMode,
// integration configs (non-secret fields), display options.

import type { DisplayInfo } from "../types/stage.js";
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
  displays: DisplayInfo[];
  /** Allowlisted service type IDs for auto mode. Empty = all allowed. */
  allowedServiceTypeIds: string[];
  /** Polling/metering interval (ms) applied to all wireless gear. */
  wirelessMeterRateMs: number;
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
