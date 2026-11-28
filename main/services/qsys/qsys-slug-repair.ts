// qsys-slug-repair.ts — panel blocks on a views file read from disk, made to hold.
//
// Every write path keeps a panel's slug unique, its block well formed and a panel a
// custom console. A file can still arrive that breaks one of those: a backup taken
// before an import learned to suffix a clashing slug, a hand edit, a downgrade and
// back, a newer build's field. Such a file is the operator's work, so a restore
// never refuses it over these, a load never throws on them, and nothing in a block
// is thrown away:
//
//   - two panels at one address: the first view in the file keeps it, and each
//     later one takes the next free numeric suffix (uniqueQsysSlug, the rule an
//     import uses), never another panel's own slug or old address;
//   - a block on a view that cannot be a panel (Home, a display, another kind), or
//     one the parser refuses (a hand-edited slug, a field this build does not
//     have): moved whole, as it was, onto the view's `qsysInactive` list, which
//     nothing reads as a panel. /qsys/manage shows it and offers to restore it once
//     the view can be a panel again, or to dismiss it;
//   - a `qsysInactive` that is not a list (a hand edit): wrapped as a list of one,
//     never replaced;
//   - an old address (alias) that is now another panel's address, or that an
//     earlier panel in the file already keeps: no longer kept, since it cannot
//     lead to this panel. The panel itself is untouched;
//   - `qsys: null` reads as no block.
//
// Each change is a `[qsys]` line naming the view and, for a block moved aside, the
// whole block. The changes to a block are also kept for /qsys/manage for as long
// as this process runs, every load's added to the last's, so a reload after the
// repaired file was saved (which finds nothing more to do) does not hide them. The
// file is not written here: the next save of the views writes it repaired (the
// inert blocks with it), and a load after that finds nothing to say.

import { scrub } from "../scrub.js";
import { canBeQsysPanel, parseQsysPanelBlock, uniqueQsysSlug, type QsysPanelBlock, type QsysSlugRepair } from "../../types/qsys.js";
import type { View } from "../../types/views.js";

export type { QsysSlugRepair };

/** How much of a block set aside, or dismissed, its log line carries: past any block
 *  this app writes, and the most an import lets a kept-aside entry be. */
export const KEPT_BLOCK_LOG_MAX = 4096;

const repairsSeen: QsysSlugRepair[] = [];
const seenKeys = new Set<string>();

/** What every load of the views this process made changed, for /qsys/manage. */
export function qsysSlugRepairs(): QsysSlugRepair[] {
  return repairsSeen;
}

/** A view's kept-aside list as a list: a value that is not one becomes its only entry. */
function inactiveOf(v: View): unknown[] {
  const raw = (v as { qsysInactive?: unknown }).qsysInactive;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** The view with `block` moved, as it was, onto its inert list. */
function setAside(v: View, block: unknown): View {
  const { qsys: _moved, ...rest } = v;
  return { ...rest, qsysInactive: [...inactiveOf(v), block] } as View;
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
  // Every usable panel address as the file has it (slugs and old addresses), so a
  // later duplicate's suffix never takes one another panel in the file holds. The
  // first view naming a slug owns it.
  const taken = new Set<string>();
  const owner = new Map<string, View>();
  for (const [v, p] of parsed) {
    if (!("block" in p) || !canBeQsysPanel(v)) continue;
    taken.add(p.block.slug);
    for (const a of p.block.aliases ?? []) taken.add(a);
    if (!owner.has(p.block.slug)) owner.set(p.block.slug, v);
  }
  let changed = false;
  const out = views.map((v) => {
    if (v === null || typeof v !== "object") return v;
    let view = v;
    const inactive = (v as { qsysInactive?: unknown }).qsysInactive;
    if (inactive !== undefined && !Array.isArray(inactive)) {
      changed = true;
      console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) had kept-aside panel settings that were not a list; kept as a list of one: ${scrub(JSON.stringify(inactive), KEPT_BLOCK_LOG_MAX)}`);
      view = { ...v, qsysInactive: [inactive] };
    }
    if (!("qsys" in view)) return view;
    if (view.qsys === null || view.qsys === undefined) {
      changed = true;
      const { qsys: _none, ...rest } = view;
      return rest as View;
    }
    const p = parsed.get(v)!;
    if (!("block" in p)) {
      changed = true;
      repairs.push({ viewId: String(v.id), name: String(v.name), from: null, to: null, why: "malformed" });
      console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) has panel settings this app cannot read (${scrub(p.error)}); kept aside, not a panel: ${scrub(JSON.stringify(v.qsys), KEPT_BLOCK_LOG_MAX)}`);
      return setAside(view, view.qsys);
    }
    if (!canBeQsysPanel(v)) {
      changed = true;
      repairs.push({ viewId: v.id, name: v.name, from: p.block.slug, to: null, why: "not-a-console" });
      console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) had panel settings for /qsys/${scrub(p.block.slug)} but is not a custom console; kept aside, not a panel: ${scrub(JSON.stringify(v.qsys), KEPT_BLOCK_LOG_MAX)}`);
      return setAside(view, view.qsys);
    }
    if (owner.get(p.block.slug) === v) return view;
    const slug = uniqueQsysSlug(p.block.slug, taken);
    taken.add(slug);
    changed = true;
    repairs.push({ viewId: v.id, name: v.name, from: p.block.slug, to: slug, why: "shared" });
    console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) shared /qsys/${scrub(p.block.slug)} with an earlier panel; it opens at /qsys/${scrub(slug)} now`);
    return { ...view, qsys: { ...p.block, slug } };
  });

  // Old addresses: one that is now a panel's own, or that an earlier panel already
  // keeps, cannot lead here, so it is no longer kept.
  const live = new Set(out.flatMap((v) => (v && typeof v === "object" && v.qsys ? [v.qsys.slug] : [])));
  const claimed = new Set<string>();
  const final = out.map((v) => {
    if (!v || typeof v !== "object" || !v.qsys?.aliases) return v;
    const keep = v.qsys.aliases.filter((a) => !live.has(a) && !claimed.has(a));
    for (const a of keep) claimed.add(a);
    if (keep.length === v.qsys.aliases.length) return v;
    changed = true;
    const gone = v.qsys.aliases.filter((a) => !keep.includes(a));
    console.warn(`[qsys] views.json: "${scrub(v.name)}" (${scrub(v.id)}) no longer keeps its old address(es) ${scrub(gone.map((a) => `/qsys/${a}`).join(", "))}: another panel has them`);
    const { aliases: _old, ...block } = v.qsys;
    return { ...v, qsys: keep.length > 0 ? { ...block, aliases: keep } : block };
  });

  for (const r of repairs) {
    const key = JSON.stringify(r);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    repairsSeen.push(r);
  }
  return (changed ? final : raw) as V;
}
