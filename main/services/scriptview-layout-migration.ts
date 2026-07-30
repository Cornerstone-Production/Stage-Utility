import type { ScriptViewLayout } from "../types/stage.js";
import type { CategoryRole } from "../types/scriptview-roles.js";
import { seedRoles } from "./scriptview-roles-store.js";

/**
 * Rewrite name-based layouts to role ids, creating a single-member role per distinct
 * name. Lossless: every layout renders exactly as before, and the operator then merges
 * roles (dragging "Audio/Visual" into "Audio") to gain cross-service-type portability.
 *
 * Idempotent, because it runs on every load rather than behind a version stamp — a
 * layout that already has `columnRoles` is left untouched.
 */
export function migrateLayouts(
  layouts: ScriptViewLayout[],
  roles: CategoryRole[],
): { layouts: ScriptViewLayout[]; roles: CategoryRole[] } {
  const byName = new Map(roles.map((r) => [r.name.trim().toLowerCase(), r]));
  const nextRoles = [...roles];

  const roleFor = (name: string): string | null => {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    const existing = byName.get(key);
    if (existing) return existing.id;
    const [created] = seedRoles([name]);
    byName.set(key, created);
    nextRoles.push(created);
    return created.id;
  };

  const nextLayouts = layouts.map((l) => {
    if (l.columnRoles) return l; // already migrated
    const columnRoles = (l.columns ?? []).map(roleFor).filter((x): x is string => !!x);
    const accentRole = l.accentDepartment ? roleFor(l.accentDepartment) : null;
    // Drop the legacy fields so nothing reads them by accident after migration.
    const { columns: _columns, accentDepartment: _accent, ...rest } = l;
    return { ...rest, columnRoles, ...(accentRole ? { accentRole } : {}) };
  });

  return { layouts: nextLayouts, roles: nextRoles };
}
