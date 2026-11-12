// Persists ServiceCue layouts — named column presets for the rundown pages. A flat
// list shared across every service type; columns reference category ROLES so one
// layout resolves correctly whatever a given service type calls a department (see
// servicecue-roles-store.ts).

import type { ServiceCueLayout } from "../types/stage.js";
import { DataStore } from "./data-store.js";
import { asArray, checked, namedEntries, optional, refuse } from "./restore-check.js";
import { SERVICECUE_LOG_TAG } from "./servicecue-legacy-names.js";
import { serviceCueRolesStore } from "./servicecue-roles-store.js";
import { migrateLayouts } from "./servicecue-layout-migration.js";
import { assignSlugs, isSlug, prepareLayoutsImport, prepareLayoutsSave } from "./servicecue-slug.js";

// No starter layouts. They used to hardcode category names — "Audio", "Stage Manager",
// "MD + Playback Tech" — which only exist in some churches, and in this org only in some
// service types, so a fresh install got layouts whose columns rendered empty. A layout
// is cheap to add; a wrong one that looks broken is not.
const store = new DataStore<ServiceCueLayout[]>("servicecue-layouts.json", [], "config", {
  renamedFrom: { filename: "scriptview-layouts.json", logTag: SERVICECUE_LOG_TAG },
  // POST /api/servicecue/layouts takes a list; each layout an id, a name and
  // its columns, the shape migrateLayouts reads on load. A slug is the address a
  // screen is pinned to, so a malformed one is refused here rather than replaced on load.
  restoreCheck: checked((raw) => {
    namedEntries(raw, "the ServiceCue layouts").forEach((l, i) => {
      for (const k of ["columns", "columnRoles"] as const) {
        if (l[k] !== undefined) asArray(l[k], `ServiceCue layout ${i + 1}'s ${k}`);
      }
      if (l.slug !== undefined && !isSlug(l.slug)) {
        refuse(`ServiceCue layout ${i + 1}'s slug must be lower-case letters, digits and single hyphens`);
      }
      optional(l.autoNamed, "boolean", `ServiceCue layout ${i + 1}'s autoNamed`);
    });
    return raw;
  }),
});

async function load(): Promise<ServiceCueLayout[]> {
  const raw = await store.load();
  const list = Array.isArray(raw) ? raw : [];
  const roles = await serviceCueRolesStore.load();
  // Migrated against roles served as the defaults, the layouts would be saved
  // pointing at roles the real file does not hold. And once either file has
  // failed a read, its save is refused, so the migration would stop half-way.
  // Slugs are only added to what is returned, never written, for the same reason.
  if (store.refusingSaves() || serviceCueRolesStore.refusingSaves()) return assignSlugs(list);
  const migrated = migrateLayouts(list, roles);
  const out = { layouts: assignSlugs(migrated.layouts), roles: migrated.roles };
  // Runs on every load rather than behind a version stamp, so it must be idempotent —
  // only persist when it actually changed something.
  if (JSON.stringify(out.layouts) !== JSON.stringify(list)) {
    await store.save(out.layouts);
    await serviceCueRolesStore.save(out.roles);
    console.log("[servicecue-layouts] migrated saved layouts (category names to roles, URL slugs)");
  }
  return out.layouts;
}

export const serviceCueLayoutsStore = {
  load,

  /** Saves the list and returns it as stored, with the slugs the server decided (see
   *  prepareLayoutsSave). Throws LayoutNameRefused, having written nothing, for a name
   *  the rules refuse. */
  async save(layouts: ServiceCueLayout[]): Promise<ServiceCueLayout[]> {
    const out = prepareLayoutsSave(layouts, await load());
    await store.save(out);
    return out;
  },

  /** Appends layouts from an export file, whose ids the caller has checked are new. Never
   *  refuses: a name already here is changed to a free one, and `renamed` says which (see
   *  prepareLayoutsImport). */
  async importLayouts(incoming: ServiceCueLayout[]): Promise<{ from: string; to: string }[]> {
    const { layouts, renamed } = prepareLayoutsImport(incoming, await load());
    await store.save(layouts);
    return renamed;
  },
};
