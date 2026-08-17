// Merge a bundle into this install.
//
// The substantive difference from a config snapshot restore: that REPLACES whole
// files, this merges into files that already hold the operator's other views. So
// every write here is additive, and nothing local is ever overwritten — not a
// view, not a name, not a target definition.

import { randomUUID } from "node:crypto";

import { remapBundle } from "./view-remap.js";
import { collectRefs } from "./view-refs.js";
import { viewsStore } from "./views-store.js";
import { slotsStore } from "./slots-store.js";
import { notesStore } from "./notes-store.js";
import { scriptViewLayoutsStore } from "./scriptview-layouts-store.js";
import { oscStore } from "./osc-store.js";
import { rosstalkStore } from "./rosstalk-store.js";
import { saveLayoutImageBytes } from "./layout-image-store.js";
import type { ViewBundle, ImportReport } from "../types/view-bundle.js";
import type { View } from "../types/views.js";
import type { Slot } from "../types/pco.js";

function assertBundle(b: unknown): asserts b is ViewBundle {
  const o = b as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("import — not a JSON object");
  if (o.kind !== "stage-utility-view") {
    // Named, because picking the config snapshot by mistake is the likely error
    // and "invalid file" would teach nobody anything.
    throw new Error(`import — this is a "${String(o.kind)}" file, not a view export`);
  }
  if (o.version !== 1) throw new Error(`import — unsupported version ${String(o.version)}`);
  if (!Array.isArray(o.views) || o.views.length === 0) throw new Error("import — no views in the file");
}

/** `Left Display` -> `Left Display (imported)` when taken. */
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name} (imported)`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${name} (imported ${n++})`;
  return candidate;
}

export async function applyViewBundle(raw: unknown): Promise<ImportReport> {
  assertBundle(raw);
  const bundle = raw;

  const existing = await viewsStore.load();
  const usedIds = new Set(existing.map((v) => v.id));
  let counter = 1;
  const mintViewId = (): string => {
    while (usedIds.has(`view-${counter}`)) counter++;
    const id = `view-${counter}`;
    usedIds.add(id);
    return id;
  };

  const { views, objectIdMap } = remapBundle(bundle.views as View[], () => mintViewId());

  const takenNames = new Set(existing.map((v) => v.name));
  const reportViews: ImportReport["views"] = [];
  const named = views.map((v) => {
    const name = freeName(v.name, takenNames);
    takenNames.add(name);
    reportViews.push(name === v.name ? { id: v.id, name } : { id: v.id, name, renamedFrom: v.name });
    return { ...v, name };
  });

  await viewsStore.save([...existing, ...named]);

  // Side data, re-keyed. A key may be a layout OBJECT id (an inline slots-grid)
  // or a VIEW id (a slots view); the view map is by position, which remapBundle
  // preserves.
  const viewKeyMap = new Map(bundle.views.map((v, i) => [(v as View).id, named[i].id]));
  for (const [oldKey, byServiceType] of Object.entries(bundle.sideData.slots ?? {})) {
    const newKey = objectIdMap.get(oldKey) ?? viewKeyMap.get(oldKey);
    if (!newKey) continue;
    for (const [serviceTypeId, rows] of Object.entries(byServiceType ?? {})) {
      // Fresh slot ids, matching what duplicateView does: two views must never
      // share a slot row identity.
      const fresh = (rows as Slot[]).map((r) => ({ ...r, id: randomUUID() }));
      await slotsStore.setSlots(newKey, serviceTypeId, fresh);
    }
  }

  await notesStore.init();
  for (const [oldId, content] of Object.entries(bundle.sideData.notes ?? {})) {
    const newId = objectIdMap.get(oldId);
    if (newId) await notesStore.set(newId, content as never);
  }

  const svIncoming = bundle.sideData.scriptviewLayouts ?? [];
  if (svIncoming.length) {
    const cur = await scriptViewLayoutsStore.load();
    const have = new Set(cur.map((l) => l.id));
    const add = svIncoming.filter((l) => !have.has((l as { id: string }).id));
    if (add.length) await scriptViewLayoutsStore.save([...cur, ...add] as never);
  }

  // Targets: add what is missing, never touch what is here. A local definition
  // is the operator's, and an import is not a reason to lose it.
  const targetsAdded: ImportReport["targetsAdded"] = [];
  const targetsKept: ImportReport["targetsKept"] = [];

  const mergeTargets = async (
    kind: "osc" | "rosstalk",
    cur: { id: string; name?: string }[],
    incoming: { id: string; name?: string }[],
    save: (next: unknown[]) => Promise<void>,
  ): Promise<void> => {
    const have = new Set(cur.map((t) => t.id));
    const add: unknown[] = [];
    for (const t of incoming) {
      const row = { kind, id: t.id, name: t.name ?? t.id };
      if (have.has(t.id)) targetsKept.push(row);
      else { add.push(t); targetsAdded.push(row); }
    }
    if (add.length) await save([...cur, ...add]);
  };

  await mergeTargets(
    "osc",
    (await oscStore.load()) as unknown as { id: string; name?: string }[],
    (bundle.targets?.osc ?? []) as { id: string; name?: string }[],
    (next) => oscStore.save(next as never),
  );
  await mergeTargets(
    "rosstalk",
    (await rosstalkStore.loadTargets()) as unknown as { id: string; name?: string }[],
    (bundle.targets?.rosstalk ?? []) as { id: string; name?: string }[],
    (next) => rosstalkStore.saveTargets(next as never),
  );

  // Images. Content-addressed, so a logo already here collapses to the same file
  // rather than duplicating.
  const images = { written: 0, shared: 0, failed: [] as string[] };
  for (const [ref, b64] of Object.entries(bundle.images ?? {})) {
    if (!ref.startsWith("layout-images/")) {
      images.failed.push(`${ref}: not a layout image`);
      continue;
    }
    try {
      const fresh = await saveLayoutImageBytes(
        ref.slice("layout-images/".length),
        Buffer.from(b64, "base64"),
      );
      if (fresh) images.written++;
      else images.shared++;
    } catch (err) {
      // Recorded and RETURNED, never swallowed. Nothing is rolled back either: a
      // layout missing one image is more useful than no layout, and the operator
      // is told which.
      images.failed.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The rebind list, from the same walk export uses — so what the review screen
  // promised and what landed cannot disagree.
  const rebind = named.flatMap((v) => collectRefs(named, v.id).unresolvable)
    .filter((u, i, all) => all.findIndex((o) => o.objectId === u.objectId && o.value === u.value) === i);

  return { views: reportViews, targetsAdded, targetsKept, images, rebind };
}
