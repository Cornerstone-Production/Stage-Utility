// Category roles — editable alias sets that let one layout work across service types
// that name the same department differently.

import type { CategoryRole } from "../types/servicecue-roles.js";
import { DataStore } from "./data-store.js";
import { asArray, checked } from "./restore-check.js";
import { SERVICECUE_LOG_TAG } from "./servicecue-legacy-names.js";

const store = new DataStore<CategoryRole[]>("servicecue-roles.json", [], "config", {
  renamedFrom: { filename: "scriptview-roles.json", logTag: SERVICECUE_LOG_TAG },
  restoreCheck: checked((raw) => cleanRoles(asArray(raw, "the roles"))),
});

/**
 * What POST /api/servicecue/roles saves of a list: roles with a text id and a
 * name that is not blank, the name trimmed, members trimmed and deduplicated.
 * Shared by that route and a config restore.
 */
export function cleanRoles(roles: readonly unknown[]): CategoryRole[] {
  return (roles as Partial<CategoryRole>[])
    .filter((r): r is CategoryRole => !!r && typeof r.id === "string" && typeof r.name === "string" && !!r.name.trim())
    .map((r) => ({
      id: r.id,
      name: r.name.trim(),
      members: [...new Set((Array.isArray(r.members) ? r.members : []).map((m) => String(m).trim()).filter(Boolean))],
    }));
}

/** Stable id from a category name, so re-seeding does not churn ids, made unique
 *  against `taken` with a numeric suffix. A role keeps its id when it is renamed or
 *  loses its category, and two names can reduce to one id ("A&V", "A V"), so the bare
 *  id may already belong to another role. */
function idFor(name: string, taken: Set<string>): string {
  const base = `role-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * One role per category, named after it, containing only itself.
 *
 * Deliberately does NOT merge look-alike names. Keyword matching guesses badly — in
 * measurement "Stage Manager" matched a band keyword through "man(ag)er", and a "band"
 * rule swallowed nine categories in one service type. A wrong automatic merge hides a
 * department's notes with no visible cause, so merging is always the operator's action.
 */
export function seedRoles(categories: string[], existingIds: Iterable<string> = []): CategoryRole[] {
  const taken = new Set(existingIds);
  const seen = new Set<string>();
  const out: CategoryRole[] = [];
  for (const raw of categories) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: idFor(name, taken), name, members: [name] });
  }
  return out;
}

export const serviceCueRolesStore = {
  async load(): Promise<CategoryRole[]> {
    const raw = await store.load();
    return Array.isArray(raw) ? raw : [];
  },
  async save(roles: CategoryRole[]): Promise<void> {
    await store.save(roles);
  },
  /** Why saves to the roles are refused: see DataStore.refusingSaves(). */
  refusingSaves() {
    return store.refusingSaves();
  },
};
