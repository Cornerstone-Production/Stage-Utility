import type { CategoryRole } from "../../main/types/scriptview-roles.js";

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
