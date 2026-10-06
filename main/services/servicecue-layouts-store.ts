// Persists ServiceCue layouts — named column presets for the rundown pages. A flat
// list shared across every service type; columns reference category ROLES so one
// layout resolves correctly whatever a given service type calls a department (see
// servicecue-roles-store.ts).

import type { ServiceCueLayout } from "../types/stage.js";
import { DataStore } from "./data-store.js";
import { SERVICECUE_LOG_TAG } from "./servicecue-legacy-names.js";
import { serviceCueRolesStore } from "./servicecue-roles-store.js";
import { migrateLayouts } from "./servicecue-layout-migration.js";

// No starter layouts. They used to hardcode category names — "Audio", "Stage Manager",
// "MD + Playback Tech" — which only exist in some churches, and in this org only in some
// service types, so a fresh install got layouts whose columns rendered empty. A layout
// is cheap to add; a wrong one that looks broken is not.
const store = new DataStore<ServiceCueLayout[]>("servicecue-layouts.json", [], "config", {
  renamedFrom: { filename: "scriptview-layouts.json", logTag: SERVICECUE_LOG_TAG },
});

export const serviceCueLayoutsStore = {
  async load(): Promise<ServiceCueLayout[]> {
    const raw = await store.load();
    const list = Array.isArray(raw) ? raw : [];
    const roles = await serviceCueRolesStore.load();
    const out = migrateLayouts(list, roles);
    // Runs on every load rather than behind a version stamp, so it must be idempotent —
    // only persist when it actually changed something.
    if (JSON.stringify(out.layouts) !== JSON.stringify(list)) {
      await store.save(out.layouts);
      await serviceCueRolesStore.save(out.roles);
      console.log("[servicecue-layouts] migrated columns from category names to roles");
    }
    return out.layouts;
  },

  async save(layouts: ServiceCueLayout[]): Promise<void> {
    return store.save(layouts);
  },
};
