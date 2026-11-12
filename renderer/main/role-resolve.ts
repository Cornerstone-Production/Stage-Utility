import type { CategoryRole } from "../../main/types/servicecue-roles.js";

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The text for a role on one item: the non-empty members joined in the role's order.
 *
 * That single rule covers all three cases — one member populated shows it, a blank or
 * absent first member falls through to the next, and several populated members merge
 * first-listed first.
 */
export function resolveRole(role: CategoryRole, notesByCategory: Record<string, string>): string {
  const parts: string[] = [];
  for (const member of role.members) {
    // Notes are keyed by PCO's exact name; match case-insensitively so a role written
    // "eg 1 (lead)" still finds "EG 1 (LEAD)".
    const key = Object.keys(notesByCategory).find((k) => norm(k) === norm(member));
    const value = key ? (notesByCategory[key] ?? "").trim() : "";
    if (value) parts.push(value);
  }
  return parts.join("\n");
}

/** Whether this service type defines any of the role's members. A role that matches
 *  none is HIDDEN rather than rendered as an empty column — that empty column is the
 *  bug this replaces. */
export function roleAppliesTo(role: CategoryRole, categories: string[]): boolean {
  const have = new Set(categories.map(norm));
  return role.members.some((m) => have.has(norm(m)));
}

/** The id prefix of a column made for a category in no role. Role ids are `role-…`, so
 *  nothing a person names can collide with it. */
export const UNASSIGNED_ID_PREFIX = "category:";

/**
 * One single-member role for each category in `categories` that no role names, in the
 * order given (Planning Center's own order, so it is stable from one plan to the next).
 * Spellings that differ only in case are one column. Nothing is saved: these exist for
 * the length of a render, so All columns shows a category before anyone has made a role
 * for it.
 */
export function unassignedCategoryRoles(roles: CategoryRole[], categories: string[]): CategoryRole[] {
  const claimed = new Set(roles.flatMap((r) => r.members.map(norm)));
  const found = new Map<string, string>();
  for (const c of categories) {
    const key = norm(c);
    if (key && !claimed.has(key) && !found.has(key)) found.set(key, c);
  }
  // Notes are matched to a member without regard to case (see resolveRole), so the
  // first spelling reads every variant.
  return [...found].map(([key, name]) => ({ id: `${UNASSIGNED_ID_PREFIX}${key}`, name, members: [name] }));
}
