// Persists ScriptView-wide config — currently which service types appear on the
// landing page (curated per church, since service types differ between orgs).

import type { ScriptViewConfig } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<ScriptViewConfig>("scriptview-config.json", { serviceTypeIds: [] });

export const scriptViewConfigStore = {
  async load(): Promise<ScriptViewConfig> {
    return store.load();
  },
  async save(config: ScriptViewConfig): Promise<void> {
    return store.save(config);
  },
};
