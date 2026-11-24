// qsys-slug-repair.ts — panel blocks on a views file read from disk, made to hold.
//
// Every write path keeps a panel's slug unique and a panel a custom console. A
// file can still arrive that breaks either: a backup taken before an import learned
// to suffix a clashing slug, a hand edit, a downgrade and back. Such a file is the
// operator's work, so a restore never refuses it and a load never throws: the
// first view in the file keeps a shared slug and each later one takes the next free
// numeric suffix (the rule an import uses), a block on a view that cannot be a
// panel is dropped, and `qsys: null` reads as no block. Each change is logged on a
// `[qsys]` line and kept for /qsys/manage to show, for as long as this process
// runs. The file is not written here; the next save of the views writes it
// repaired, and a load after that finds nothing to say.

import { HOME_VIEW_ID } from "../home-view.js";
import { scrub } from "../scrub.js";
import { uniqueQsysSlug } from "../../types/qsys.js";
import { viewSurface, type View } from "../../types/views.js";

/** One change a load made to a panel block. `to` null: the block was dropped. */
export interface QsysSlugRepair {
  viewId: string;
  name: string;
  from: string;
  to: string | null;
  why: "shared" | "not-a-console";
}

let lastRepairs: QsysSlugRepair[] = [];

/** A panel is a custom console, and never Home. */
const canBePanel = (v: View): boolean => v.id !== HOME_VIEW_ID && v.kind === "custom" && viewSurface(v) === "console";

/** What the last load of the views changed, for /qsys/manage. */
export function qsysSlugRepairs(): QsysSlugRepair[] {
  return lastRepairs;
}

/**
 * The views with every panel block made to hold, and the same array back when
 * nothing needed it (so a load that finds nothing allocates nothing). Records and
 * logs what changed. Blocks are shaped by the restore check and every write; this
 * looks only at what those cannot see from one view at a time.
 */
export function repairQsysBlocks<V>(raw: V): V {
  if (!Array.isArray(raw)) return raw;
  const views = raw as View[];
  const repairs: QsysSlugRepair[] = [];
  // Every slug as the file has it, so a later duplicate's suffix never takes a slug
  // another panel in the file already holds. The first view naming a slug owns it.
  const taken = new Set<string>();
  const owner = new Map<string, View>();
  for (const v of views) {
    const slug = v && typeof v === "object" && v.qsys && canBePanel(v) ? v.qsys.slug : undefined;
    if (typeof slug !== "string") continue;
    taken.add(slug);
    if (!owner.has(slug)) owner.set(slug, v);
  }
  let changed = false;
  const out = views.map((v) => {
    if (v === null || typeof v !== "object" || !("qsys" in v)) return v;
    if (v.qsys === null || v.qsys === undefined) {
      changed = true;
      const { qsys: _none, ...rest } = v;
      return rest as View;
    }
    const block = v.qsys;
    if (!canBePanel(v)) {
      changed = true;
      repairs.push({ viewId: v.id, name: v.name, from: block.slug, to: null, why: "not-a-console" });
      const { qsys: _dropped, ...rest } = v;
      return rest as View;
    }
    if (owner.get(block.slug) === v) return v;
    const slug = uniqueQsysSlug(block.slug, taken);
    taken.add(slug);
    changed = true;
    repairs.push({ viewId: v.id, name: v.name, from: block.slug, to: slug, why: "shared" });
    return { ...v, qsys: { ...block, slug } };
  });
  lastRepairs = repairs;
  for (const r of repairs) {
    if (r.to === null) {
      console.warn(`[qsys] views.json: "${scrub(r.name)}" (${scrub(r.viewId)}) had panel settings for /qsys/${scrub(r.from)} but is not a custom console; it is an ordinary view now`);
    } else {
      console.warn(`[qsys] views.json: "${scrub(r.name)}" (${scrub(r.viewId)}) shared /qsys/${scrub(r.from)} with an earlier panel; it opens at /qsys/${scrub(r.to)} now`);
    }
  }
  return (changed ? out : raw) as V;
}
