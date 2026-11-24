// qsys-slug-repair.ts — panel blocks on a views file read from disk, made to hold.
//
// Every write path keeps a panel's slug unique, its block well formed and a panel a
// custom console. A file can still arrive that breaks one of those: a backup taken
// before an import learned to suffix a clashing slug, a hand edit, a downgrade and
// back. Such a file is the operator's work, so a restore never refuses it over
// these, a load never throws on them, and nothing in a block is thrown away:
//
//   - two panels at one address: the first view in the file keeps it, and each
//     later one takes the next free numeric suffix (uniqueQsysSlug, the rule an
//     import uses), never another panel's own slug;
//   - a block on a view that cannot be a panel (Home, a display, another kind), or
//     one the parser refuses (a hand-edited slug): moved whole, as it was, onto the
//     view's `qsysInactive` list, which nothing reads as a panel. /qsys/manage shows
//     it and offers to restore it once the view can be a panel again;
//   - `qsys: null` reads as no block.
//
// Each change is a `[qsys]` line naming the view and, for a block moved aside, the
// whole block; and is kept for /qsys/manage for as long as this process runs. The
// file is not written here: the next save of the views writes it repaired (the
// inert blocks with it), and a load after that finds nothing to say.

import { HOME_VIEW_ID } from "../home-view.js";
import { scrub } from "../scrub.js";
import { parseQsysPanelBlock, uniqueQsysSlug, type QsysPanelBlock } from "../../types/qsys.js";
import { viewSurface, type View } from "../../types/views.js";

/** One change a load made to a panel block. `to` null: the block was moved aside, whole. */
export interface QsysSlugRepair {
  viewId: string;
  name: string;
  /** The slug the file gave, when it had a usable one. */
  from: string | null;
  to: string | null;
  why: "shared" | "not-a-console" | "malformed";
}

let lastRepairs: QsysSlugRepair[] = [];

/** A panel is a custom console, and never Home. */
const canBePanel = (v: View): boolean => v.id !== HOME_VIEW_ID && v.kind === "custom" && viewSurface(v) === "console";

/** What the last load of the views changed, for /qsys/manage. */
export function qsysSlugRepairs(): QsysSlugRepair[] {
  return lastRepairs;
}

/** The view with `block` moved, as it was, onto its inert list. */
function setAside(v: View, block: unknown): View {
  const { qsys: _moved, ...rest } = v;
  const kept = Array.isArray(v.qsysInactive) ? v.qsysInactive : [];
  return { ...rest, qsysInactive: [...kept, block] } as View;
}

/**
 * The views with every panel block made to hold, and the same array back when
 * nothing needed it (so a load that finds nothing allocates nothing). Records and
 * logs what changed. Never throws on a block, however it is shaped.
 */
export function repairQsysBlocks<V>(raw: V): V {
  if (!Array.isArray(raw)) return raw;
  const views = raw as View[];
  const repairs: QsysSlugRepair[] = [];
  // Each block as the parser reads it, or why it cannot be read.
  const parsed = new Map<View, { block: QsysPanelBlock } | { error: string }>();
  for (const v of views) {
    if (v !== null && typeof v === "object" && v.qsys !== undefined && v.qsys !== null) parsed.set(v, parseQsysPanelBlock(v.qsys));
  }
  // Every usable panel slug as the file has it, so a later duplicate's suffix never
  // takes a slug another panel in the file already holds. The first view naming a
  // slug owns it.
  const taken = new Set<string>();
  const owner = new Map<string, View>();
  for (const [v, p] of parsed) {
    if (!("block" in p) || !canBePanel(v)) continue;
    taken.add(p.block.slug);
    if (!owner.has(p.block.slug)) owner.set(p.block.slug, v);
  }
  let changed = false;
  const out = views.map((v) => {
    if (v === null || typeof v !== "object" || !("qsys" in v)) return v;
    if (v.qsys === null || v.qsys === undefined) {
      changed = true;
      const { qsys: _none, ...rest } = v;
      return rest as View;
    }
    const p = parsed.get(v)!;
    if (!("block" in p)) {
      changed = true;
      repairs.push({ viewId: String(v.id), name: String(v.name), from: null, to: null, why: "malformed" });
      console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) has panel settings this app cannot read (${scrub(p.error)}); kept aside, not a panel: ${scrub(JSON.stringify(v.qsys), 600)}`);
      return setAside(v, v.qsys);
    }
    if (!canBePanel(v)) {
      changed = true;
      repairs.push({ viewId: v.id, name: v.name, from: p.block.slug, to: null, why: "not-a-console" });
      console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) had panel settings for /qsys/${scrub(p.block.slug)} but is not a custom console; kept aside, not a panel: ${scrub(JSON.stringify(v.qsys), 600)}`);
      return setAside(v, v.qsys);
    }
    if (owner.get(p.block.slug) === v) return v;
    const slug = uniqueQsysSlug(p.block.slug, taken);
    taken.add(slug);
    changed = true;
    repairs.push({ viewId: v.id, name: v.name, from: p.block.slug, to: slug, why: "shared" });
    console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) shared /qsys/${scrub(p.block.slug)} with an earlier panel; it opens at /qsys/${scrub(slug)} now`);
    return { ...v, qsys: { ...p.block, slug } };
  });
  lastRepairs = repairs;
  return (changed ? out : raw) as V;
}
