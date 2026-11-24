// A bundle's Q-SYS panels, landed on this install.
//
// Pure: no store, no log. view-import.ts calls it with the views as remapped and
// the views already here, and logs what it returns.
//
// A panel's slug is its URL (/qsys/<slug>), so it is unique across the views. A
// bundle brings its own, which may name a panel already here, or another panel in
// the same file. A clash takes the next free numeric suffix (-2, -3, ...); the
// existing panel is never touched. A sibling the file names by a slug that was
// renamed follows the rename, so the cog menu still points at the panel the file
// meant and not at a local one that kept the old address.

import { parseQsysPanelBlock, qsysSlugsOf, uniqueQsysSlug, type QsysPanelBlock } from "../../types/qsys.js";
import type { View } from "../../types/views.js";

/** One imported panel, for the report. */
export interface ImportedQsysPanel {
  /** The view's id on this install. */
  id: string;
  name: string;
  slug: string;
  /** The slug the file named, when it was taken here and this one was given instead. */
  renamedFrom?: string;
  /** Siblings that name no panel here after the import. Kept in the block (the cog
   *  menu draws only those that exist) and listed on /qsys/manage. */
  missingSiblings: string[];
}

export function landQsysPanels(
  incoming: readonly View[],
  existing: readonly View[],
): { views: View[]; panels: ImportedQsysPanel[] } {
  const taken = qsysSlugsOf(existing);
  // The file's slug -> the one it landed under. The first panel to name a slug owns
  // it, which is also the one /qsys/<slug> opens.
  const renames = new Map<string, string>();
  const landed = new Map<View, string>();
  for (const v of incoming) {
    if (!v.qsys) continue;
    const slug = uniqueQsysSlug(v.qsys.slug, taken);
    taken.add(slug);
    landed.set(v, slug);
    if (!renames.has(v.qsys.slug)) renames.set(v.qsys.slug, slug);
  }

  const panels: ImportedQsysPanel[] = [];
  const views = incoming.map((v) => {
    const slug = landed.get(v);
    if (!v.qsys || slug === undefined) return v;
    const siblings = [...new Set(v.qsys.siblings.map((s) => renames.get(s) ?? s))].filter((s) => s !== slug);
    const block: QsysPanelBlock = { ...v.qsys, slug, siblings };
    panels.push({
      id: v.id,
      name: v.name,
      slug,
      ...(slug !== v.qsys.slug ? { renamedFrom: v.qsys.slug } : {}),
      missingSiblings: siblings.filter((s) => !taken.has(s)),
    });
    return { ...v, qsys: block };
  });
  return { views, panels };
}

/**
 * The views with each `qsys` block as the parser reads it (siblings listed once,
 * the return time defaulted). assertBundle has already refused a block the parser
 * rejects, so a refusal here is a bug, thrown rather than landed.
 */
export function normalizeQsysBlocks(views: readonly View[]): View[] {
  return views.map((v) => {
    if (v.qsys === undefined) return v;
    const parsed = parseQsysPanelBlock(v.qsys);
    if ("error" in parsed) throw new Error(`import: a Q-SYS panel block reached the merge unchecked: ${parsed.error}`);
    return { ...v, qsys: parsed.block };
  });
}
