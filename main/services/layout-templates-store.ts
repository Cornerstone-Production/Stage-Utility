// Persists named, reusable custom-layout templates (a library, global — not per
// service type or view).

import type { LayoutTemplate } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<LayoutTemplate[]>("layout-templates.json", []);

export const layoutTemplatesStore = {
  async load(): Promise<LayoutTemplate[]> {
    return store.load();
  },

  async save(templates: LayoutTemplate[]): Promise<void> {
    return store.save(templates);
  },
};
