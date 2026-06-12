// Persists named slot presets (global — not per service type).

import type { SlotPreset } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<SlotPreset[]>("presets.json", []);

export const presetsStore = {
  async load(): Promise<SlotPreset[]> {
    return store.load();
  },

  async save(presets: SlotPreset[]): Promise<void> {
    return store.save(presets);
  },
};
