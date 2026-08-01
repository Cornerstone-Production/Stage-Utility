// Category roles — editable alias sets that let one layout work across service types
// that name the same department differently.

import type { CategoryRole } from "../types/scriptview-roles.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<CategoryRole[]>("scriptview-roles.json", []);

/** Stable id from a category name, so re-seeding does not churn ids. */
function idFor(name: string): string {
  return `role-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * One role per category, named after it, containing only itself.
 *
 * Deliberately does NOT merge look-alike names. Keyword matching guesses badly — in
 * measurement "Stage Manager" matched a band keyword through "man(ag)er", and a "band"
 * rule swallowed nine categories in one service type. A wrong automatic merge hides a
 * department's notes with no visible cause, so merging is always the operator's action.
 */
export function seedRoles(categories: string[]): CategoryRole[] {
  const seen = new Set<string>();
  const out: CategoryRole[] = [];
  for (const raw of categories) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: idFor(name), name, members: [name] });
  }
  return out;
}

export const scriptViewRolesStore = {
  async load(): Promise<CategoryRole[]> {
    const raw = await store.load();
    return Array.isArray(raw) ? raw : [];
  },
  async save(roles: CategoryRole[]): Promise<void> {
    await store.save(roles);
  },
};
