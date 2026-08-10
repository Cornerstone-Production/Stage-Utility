// Persists the CONFIG portion of OSC targets (id, name, enabled, config).
// Runtime fields (connection/message) are never persisted.

import type { OscTargetConfig } from "../types/osc.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<OscTargetConfig[]>("osc-targets.json", [], "config");

export const oscStore = {
  async load(): Promise<OscTargetConfig[]> {
    return store.load();
  },

  async save(targets: OscTargetConfig[]): Promise<void> {
    return store.save(targets);
  },
};
