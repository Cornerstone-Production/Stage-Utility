// Every change Customize makes to the sidebar, as a function from one drawn
// arrangement to the next.
//
// Pure, so Customize mode and the out-of-mode Hide and Move to make the same
// change the same way, and so a test can check the rules without a browser. The
// rules themselves (Consoles holds consoles, Advanced never hides) are checked
// again by the server; these only keep the editor from offering what it would
// refuse.

import {
  canPlace,
  cloneSections,
  fallbackSection,
  homeSectionIn,
  isConsoleId,
  LOCKED_PAGE,
  type ResolvedSidebar,
  type SidebarSection,
} from "@main/services/sidebar-arrangement";
import { plural } from "@main/services/plural";

function clone(r: ResolvedSidebar): ResolvedSidebar {
  return { ...r, sections: cloneSections(r.sections), hiddenPages: [...r.hiddenPages], hiddenConsoles: [...r.hiddenConsoles] };
}

/** The section an id sits in, or undefined when it is hidden. */
export function sectionOf(r: ResolvedSidebar, id: string): SidebarSection | undefined {
  return r.sections.find((s) => s.members.includes(id));
}

/**
 * Put `id` in `sectionId` at `index` (clamped; Infinity is the end), from
 * wherever it was, including the tray. Null when the move breaks a rule.
 */
export function movePage(r: ResolvedSidebar, id: string, sectionId: string, index: number): ResolvedSidebar | null {
  const next = clone(r);
  const target = next.sections.find((s) => s.id === sectionId);
  if (!target || !canPlace(id, target)) return null;
  for (const s of next.sections) s.members = s.members.filter((m) => m !== id);
  next.hiddenPages = next.hiddenPages.filter((m) => m !== id);
  next.hiddenConsoles = next.hiddenConsoles.filter((m) => m !== id);
  target.members.splice(Math.max(0, Math.min(index, target.members.length)), 0, id);
  return next;
}

/** Take a page out of the sidebar. Null for Advanced and for a console, whose
 *  hiding is the view's own switch. */
export function hidePage(r: ResolvedSidebar, id: string): ResolvedSidebar | null {
  if (id === LOCKED_PAGE || isConsoleId(id)) return null;
  const next = clone(r);
  for (const s of next.sections) s.members = s.members.filter((m) => m !== id);
  if (!next.hiddenPages.includes(id)) next.hiddenPages.push(id);
  return next;
}

/** A hidden page back at the end of its home section. */
export function restorePage(r: ResolvedSidebar, id: string): ResolvedSidebar | null {
  return movePage(r, id, homeSectionIn(r.sections, id).id, Infinity);
}

/** Move a section, with its pages, to sit before `beforeId` (null: last). The
 *  top group stays first. */
export function moveSection(r: ResolvedSidebar, id: string, beforeId: string | null): ResolvedSidebar | null {
  const moving = r.sections.find((s) => s.id === id);
  if (!moving || moving.kind === "top") return null;
  const next = clone(r);
  const rest = next.sections.filter((s) => s.id !== id);
  const at = beforeId === null ? rest.length : rest.findIndex((s) => s.id === beforeId);
  const moved = next.sections.find((s) => s.id === id);
  if (!moved) return null;
  rest.splice(Math.max(1, at < 0 ? rest.length : at), 0, moved);
  next.sections = rest;
  return next;
}

export function renameSection(r: ResolvedSidebar, id: string, label: string): ResolvedSidebar | null {
  const text = label.trim();
  const target = r.sections.find((s) => s.id === id);
  if (!text || !target || target.kind === "top" || text === target.label) return null;
  const next = clone(r);
  const s = next.sections.find((x) => x.id === id);
  if (s) s.label = text;
  return next;
}

/**
 * Remove a section, sending its pages to the tray. Null for the top group and
 * Consoles. Advanced cannot go to the tray, so it moves to the last section of
 * pages left (or the top group) instead.
 */
export function removeSection(r: ResolvedSidebar, id: string): ResolvedSidebar | null {
  const target = r.sections.find((s) => s.id === id);
  if (!target || target.kind !== "pages") return null;
  const next = clone(r);
  next.sections = next.sections.filter((s) => s.id !== id);
  for (const m of target.members) {
    if (m === LOCKED_PAGE) continue;
    next.hiddenPages.push(m);
  }
  if (target.members.includes(LOCKED_PAGE)) fallbackSection(next.sections).members.push(LOCKED_PAGE);
  return next;
}

/** What the toast says when a section is removed. */
export function removedSectionMessage(section: Pick<SidebarSection, "label" | "members">): string {
  // Advanced does not go to the tray (see removeSection), so it is not counted.
  const n = section.members.filter((m) => m !== LOCKED_PAGE).length;
  if (n === 0) return `Removed ${section.label}.`;
  return `Removed ${section.label}. ${n === 1 ? "Its page is" : `Its ${plural(n, "page")} are`} in the tray.`;
}

/** A new, empty section at the end. `id` is the caller's: a new one each time. */
export function addSection(r: ResolvedSidebar, id: string, label = "New section"): ResolvedSidebar {
  const next = clone(r);
  next.sections.push({ id, label, kind: "pages", members: [] });
  return next;
}
