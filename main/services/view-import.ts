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
import { oscManager } from "./osc-manager.js";
import { rosstalkManager } from "./rosstalk-manager.js";
import { saveLayoutImageBytes } from "./layout-image-store.js";
import { isSafeKey } from "./safe-key.js";
import { isLayoutShape } from "../types/views.js";
import type { ViewBundle, ImportReport } from "../types/view-bundle.js";
import type { View } from "../types/views.js";
import type { NotesContent } from "./notes-store.js";

/**
 * Everything checked BEFORE anything is written.
 *
 * A throw partway through leaves views on disk that the controller does not know
 * about, and the next thing to save the view list would erase them. So the file
 * is either good enough to apply whole or refused whole, and the shapes the app
 * would otherwise reject on its own write path are rejected here too.
 */
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

  const seenIds = new Set<string>();
  for (const raw of o.views as unknown[]) {
    const v = raw as Record<string, unknown> | null;
    if (!v || typeof v !== "object") throw new Error("import — a view in the file is not an object");
    if (typeof v.id !== "string" || !v.id) throw new Error("import — a view in the file has no id");
    if (typeof v.name !== "string" || !v.name) throw new Error(`import — view ${v.id} has no name`);
    if (typeof v.kind !== "string" || !v.kind) throw new Error(`import — view ${v.id} has no kind`);
    // Two views sharing an id would collapse to one minted id, so both would be
    // stored under it and deleting either would remove both.
    if (seenIds.has(v.id)) throw new Error(`import — the file has two views with id ${v.id}`);
    seenIds.add(v.id);
    // null is legitimate — only a custom view has a layout at all.
    if (v.layout != null && !isLayoutShape(v.layout)) {
      throw new Error(`import — view "${v.name}" has a layout the renderer cannot draw`);
    }
  }

  const sd = o.sideData as Record<string, unknown> | undefined;
  if (sd != null && typeof sd !== "object") throw new Error("import — sideData is not an object");
  for (const [key, byServiceType] of Object.entries((sd?.slots ?? {}) as Record<string, unknown>)) {
    for (const [st, rows] of Object.entries((byServiceType ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(rows)) throw new Error(`import — slot rows for ${key}/${st} are not a list`);
    }
  }
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

  const { views, viewIdMap, objectIdMap } = remapBundle(bundle.views as View[], mintViewId);

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
  // or a VIEW id (a slots view), so both maps are consulted.
  const skipped: string[] = [];
  for (const [oldKey, byServiceType] of Object.entries(bundle.sideData?.slots ?? {})) {
    const newKey = objectIdMap.get(oldKey) ?? viewIdMap.get(oldKey);
    if (!newKey) continue;
    for (const [serviceTypeId, rows] of Object.entries(byServiceType ?? {})) {
      // A service type id is a KEY in the file, so it is whatever the file says.
      // slotsStore refuses a prototype-reaching key by throwing, which mid-import
      // would abort having already written the views — the operator would be told
      // it failed when it half-succeeded. Dropped and named instead, which is
      // what safe-key.ts prescribes for a bundle.
      if (!isSafeKey(serviceTypeId)) {
        skipped.push(`slot rows for service type "${serviceTypeId}"`);
        continue;
      }
      // Fresh slot ids, matching what duplicateView does: two views must never
      // share a slot row identity.
      const fresh = rows.map((r) => ({ ...r, id: randomUUID() }));
      await slotsStore.setSlots(newKey, serviceTypeId, fresh);
    }
  }

  await notesStore.init();
  for (const [oldId, content] of Object.entries(bundle.sideData?.notes ?? {})) {
    const newId = objectIdMap.get(oldId);
    if (newId) await notesStore.set(newId, content as NotesContent);
  }

  const svIncoming = bundle.sideData?.scriptviewLayouts ?? [];
  const svAfter = await scriptViewLayoutsStore.load();
  const svHave = new Set(svAfter.map((l) => l.id));
  if (svIncoming.length) {
    const add = svIncoming.filter((l) => !svHave.has(l.id));
    for (const l of svIncoming) {
      // A local preset of the same id wins, like a target does — but say so,
      // because the imported view then renders with the LOCAL columns.
      if (svHave.has(l.id)) skipped.push(`ScriptView preset "${l.name ?? l.id}" — kept the one already here`);
      else svHave.add(l.id);
    }
    if (add.length) await scriptViewLayoutsStore.save([...svAfter, ...add]);
  }

  // A view can point at a preset that was already missing at the source: export
  // ships only presets it can find. An unknown id renders as ALL columns, which
  // looks like a working display showing the wrong thing — the same reason
  // setViewScriptViewLayout refuses one.
  for (const v of named) {
    if (v.scriptViewLayoutId && !svHave.has(v.scriptViewLayoutId)) {
      skipped.push(`"${v.name}" points at a ScriptView preset that is not in the file or here`);
    }
  }

  // Targets: add what is missing, never touch what is here. A local definition
  // is the operator's, and an import is not a reason to lose it.
  const targetsAdded: ImportReport["targetsAdded"] = [];
  const targetsKept: ImportReport["targetsKept"] = [];

  async function mergeTargets<T extends { id: string; name: string }>(
    kind: "osc" | "rosstalk",
    cur: T[],
    incoming: T[],
    save: (next: T[]) => Promise<void>,
  ): Promise<void> {
    // `have` grows as we go: two incoming targets sharing an id would otherwise
    // both be appended, leaving a duplicate id in the store.
    const have = new Set(cur.map((t) => t.id));
    const add: T[] = [];
    for (const t of incoming) {
      const row = { kind, id: t.id, name: t.name };
      if (have.has(t.id)) targetsKept.push(row);
      else { have.add(t.id); add.push(t); targetsAdded.push(row); }
    }
    if (add.length) await save([...cur, ...add]);
  }

  await mergeTargets("osc", await oscStore.load(), bundle.targets?.osc ?? [],
    (next) => oscStore.save(next));
  await mergeTargets("rosstalk", await rosstalkStore.loadTargets(), bundle.targets?.rosstalk ?? [],
    (next) => rosstalkStore.saveTargets(next));

  // Both managers hold their targets in memory and write that array back on the
  // next edit. Writing the store without telling them means the imported target
  // is not live AND is erased the first time the operator touches any target.
  //
  // A reload that fails does NOT fail the import: the data is already correctly
  // on disk, and the only cost is that the target is not live until a restart.
  // Returned rather than logged, so the operator hears it either way.
  for (const [kind, reload] of [
    ["osc", () => oscManager.reloadTargets()],
    ["rosstalk", () => rosstalkManager.reloadTargets()],
  ] as const) {
    if (!targetsAdded.some((t) => t.kind === kind)) continue;
    try {
      await reload();
    } catch (err) {
      skipped.push(
        `${kind.toUpperCase()} targets were saved but are not live until a restart: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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

  for (const ref of bundle.missingImages ?? []) {
    skipped.push(`${ref} — the layout points at it, but it was missing when exported`);
  }

  // The rebind list, from the same walk — and computed the same way the review
  // sheet computes it, from the root, so what was promised and what landed
  // cannot disagree. Walking from the root covers every view in the bundle,
  // because export built the bundle by walking from the root.
  const rebind = collectRefs(named, named[0].id).unresolvable;

  return { views: reportViews, targetsAdded, targetsKept, images, rebind, skipped };
}
