// Persists ScriptView layouts — named column presets for the in-app ScriptViewer
// replacement. A flat list shared across every service type; columns reference category
// ROLES so one layout resolves correctly whatever a given service type calls a
// department (see scriptview-roles-store.ts).

import type { ScriptViewLayout } from "../types/stage.js";
import { DataStore } from "./data-store.js";
import { scriptViewRolesStore } from "./scriptview-roles-store.js";
import { migrateLayouts } from "./scriptview-layout-migration.js";

// No starter layouts. They used to hardcode category names — "Audio", "Stage Manager",
// "MD + Playback Tech" — which only exist in some churches, and in this org only in some
// service types, so a fresh install got layouts whose columns rendered empty. A layout
// is cheap to add; a wrong one that looks broken is not.
const store = new DataStore<ScriptViewLayout[]>("scriptview-layouts.json", [], "config");

export const scriptViewLayoutsStore = {
  async load(): Promise<ScriptViewLayout[]> {
    const raw = await store.load();
    const list = Array.isArray(raw) ? raw : [];
    const roles = await scriptViewRolesStore.load();
    const out = migrateLayouts(list, roles);
    // Runs on every load rather than behind a version stamp, so it must be idempotent —
    // only persist when it actually changed something.
    if (JSON.stringify(out.layouts) !== JSON.stringify(list)) {
      await store.save(out.layouts);
      await scriptViewRolesStore.save(out.roles);
      console.log("[scriptview-layouts] migrated columns from category names to roles");
    }
    return out.layouts;
  },

  async save(layouts: ScriptViewLayout[]): Promise<void> {
    return store.save(layouts);
  },
};
