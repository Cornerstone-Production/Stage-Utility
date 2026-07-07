// Persists ScriptView layouts — named column presets per PCO service type for the
// in-app ScriptViewer replacement. A flat list; each layout carries its own
// serviceTypeId, so one store holds every service type's presets.

import type { ScriptViewLayout } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<ScriptViewLayout[]>("scriptview-layouts.json", []);

export const scriptViewLayoutsStore = {
  async load(): Promise<ScriptViewLayout[]> {
    return store.load();
  },

  async save(layouts: ScriptViewLayout[]): Promise<void> {
    return store.save(layouts);
  },
};
