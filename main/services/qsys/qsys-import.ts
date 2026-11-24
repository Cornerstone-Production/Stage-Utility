// A bundle's Q-SYS panels, landed on this install.
//
// Pure: no store, no log. view-import.ts calls it with the views as remapped and
// the views already here, and logs what it returns.
//
// A panel's slug is its URL (/qsys/<slug>), so it is unique across the views, and
// so are the old addresses panels keep after a rename (aliases). A bundle brings
// its own, which may name a panel already here, or another panel in the same
// file. A clashing slug takes the next free numeric suffix (-2, -3, ...); the
// existing panel is never touched. An old address that is taken here is not kept
// (it leads to the panel that has it here). A sibling the file names by a slug
// that was renamed follows the rename, so the cog menu still points at the panel
// the file meant and not at a local one that kept the old address.

import { canBeQsysPanel, parseQsysPanelBlock, qsysSlugsOf, uniqueQsysSlug, type ImportedQsysPanel, type QsysPanelBlock } from "../../types/qsys.js";
import type { View } from "../../types/views.js";

export type { ImportedQsysPanel };

export function landQsysPanels(
  incoming: readonly View[],
  existing: readonly View[],
): { views: View[]; panels: ImportedQsysPanel[] } {
  const taken = qsysSlugsOf(existing);
  // The file's slug -> the one it landed under. The first panel to name a slug owns
  // it, which is also the one /qsys/<slug> opens. Every slug first, then the old
  // addresses, so a slug never loses to another panel's alias.
  const renames = new Map<string, string>();
  const landed = new Map<View, string>();
  for (const v of incoming) {
    if (!v.qsys) continue;
    const slug = uniqueQsysSlug(v.qsys.slug, taken);
    taken.add(slug);
    landed.set(v, slug);
    if (!renames.has(v.qsys.slug)) renames.set(v.qsys.slug, slug);
  }
  const aliasesOf = new Map<View, { kept: string[]; dropped: string[] }>();
  for (const v of incoming) {
    if (!v.qsys?.aliases) continue;
    const kept = v.qsys.aliases.filter((a) => !taken.has(a));
    for (const a of kept) taken.add(a);
    aliasesOf.set(v, { kept, dropped: v.qsys.aliases.filter((a) => !kept.includes(a)) });
  }

  const panels: ImportedQsysPanel[] = [];
  const views = incoming.map((v) => {
    const slug = landed.get(v);
    if (!v.qsys || slug === undefined) return v;
    const siblings = [...new Set(v.qsys.siblings.map((s) => renames.get(s) ?? s))].filter((s) => s !== slug);
    const { aliases: _file, ...rest } = v.qsys;
    const aliases = aliasesOf.get(v);
    const block: QsysPanelBlock = { ...rest, slug, siblings, ...(aliases && aliases.kept.length > 0 ? { aliases: aliases.kept } : {}) };
    panels.push({
      id: v.id,
      name: v.name,
      slug,
      ...(slug !== v.qsys.slug ? { renamedFrom: v.qsys.slug } : {}),
      ...(aliases && aliases.dropped.length > 0 ? { droppedAliases: aliases.dropped } : {}),
      missingSiblings: siblings.filter((s) => !taken.has(s)),
    });
    return { ...v, qsys: block };
  });
  return { views, panels };
}

/**
 * The views with each `qsys` block as the parser reads it (siblings listed once,
 * the return time defaulted), `null` read as no block. The one check of a file's
 * blocks, run before anything is written: a block the parser refuses, or one on
 * a view that cannot be a panel, refuses the whole import.
 */
export function normalizeQsysBlocks(views: readonly View[]): View[] {
  return views.map((v) => {
    const raw = (v as { qsys?: unknown }).qsys;
    if (raw === undefined) return v;
    if (raw === null) {
      const { qsys: _none, ...rest } = v;
      return rest as View;
    }
    const parsed = parseQsysPanelBlock(raw);
    if ("error" in parsed) throw new Error(`import — view "${v.name}" has Q-SYS panel settings that are refused: ${parsed.error}`);
    if (!canBeQsysPanel(v)) throw new Error(`import — view "${v.name}" is a Q-SYS panel, which must be a custom console`);
    return { ...v, qsys: parsed.block };
  });
}

/** Kept-aside panel settings a file may bring on one view: how many, and how big each. */
export const QSYS_INACTIVE_IMPORT_MAX = 20;
const QSYS_INACTIVE_ENTRY_MAX_CHARS = 4096;

/** Why a file's `qsysInactive` is refused, or null when it is absent or a short list of small entries. */
export function qsysInactiveRefusal(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return "its kept-aside Q-SYS panel settings are not a list";
  if (raw.length > QSYS_INACTIVE_IMPORT_MAX) return `it keeps more than ${QSYS_INACTIVE_IMPORT_MAX} Q-SYS panel settings aside`;
  for (const e of raw) {
    const text = JSON.stringify(e);
    if (text === undefined || text.length > QSYS_INACTIVE_ENTRY_MAX_CHARS) return `one of its kept-aside Q-SYS panel settings is over ${QSYS_INACTIVE_ENTRY_MAX_CHARS} characters`;
  }
  return null;
}
