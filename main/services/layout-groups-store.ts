// Persists named, reusable layout "groups" — a single object (typically a
// container + its children) that can be inserted into any custom View. Global,
// like layout templates (not per service type or view).

import type { LayoutGroup } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<LayoutGroup[]>("layout-groups.json", []);

export const layoutGroupsStore = {
  async load(): Promise<LayoutGroup[]> {
    return store.load();
  },

  async save(groups: LayoutGroup[]): Promise<void> {
    return store.save(groups);
  },
};
