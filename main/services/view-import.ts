// Merge a bundle into this install.
//
// The substantive difference from a config snapshot restore: that REPLACES whole
// files, this merges into files that already hold the operator's other views. So
// every write here is additive, and nothing local is ever overwritten — not a
// view, not a name, not a target definition.

import { randomUUID } from "node:crypto";
import { errorMessage } from "./errors.js";

import { remapBundle } from "./view-remap.js";
import { collectRefsFrom } from "./view-refs.js";
import { viewsStore } from "./views-store.js";
import { settingsStore } from "./settings-store.js";
import { slotsStore } from "./slots-store.js";
import { patchStore } from "./patch-store.js";
import { presetsStore } from "./presets-store.js";
import { scrub } from "./scrub.js";
import { notesStore } from "./notes-store.js";
import { scriptViewLayoutsStore } from "./scriptview-layouts-store.js";
import { oscStore } from "./osc-store.js";
import { rosstalkStore } from "./rosstalk-store.js";
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

  // The plan-export sections. All optional — a view export has none of them, and
  // an older file is read exactly as it always was. Present and the wrong shape
  // refuses the WHOLE file, like everything above: half a plan landed is worse
  // than none, because the operator is told it worked.
  const plan = o.plan as Record<string, unknown> | undefined;
  if (plan != null) {
    if (typeof plan !== "object" || Array.isArray(plan)) throw new Error("import — plan is not an object");
    if (typeof plan.serviceTypeId !== "string" || !plan.serviceTypeId) {
      throw new Error("import — the plan section has no service type id");
    }
    if (typeof plan.serviceTypeName !== "string") throw new Error("import — the plan section has no service type name");
    if (plan.slotsScope !== "type" && plan.slotsScope !== "all") {
      throw new Error(`import — the plan section has an unknown slots scope "${String(plan.slotsScope)}"`);
    }
  }

  if (o.roots != null) {
    if (!Array.isArray(o.roots) || o.roots.some((r) => typeof r !== "string" || !r)) {
      throw new Error("import — roots is not a list of view ids");
    }
  }

  if (sd?.patchVariants != null) {
    if (!Array.isArray(sd.patchVariants)) throw new Error("import — patchVariants is not a list");
    for (const raw of sd.patchVariants as unknown[]) {
      const e = raw as Record<string, unknown> | null;
      if (!e || typeof e !== "object") throw new Error("import — a patch variant entry is not an object");
      if (typeof e.sheetId !== "string" || typeof e.sheetName !== "string") {
        throw new Error("import — a patch variant entry does not name its sheet");
      }
      const v = e.variant as Record<string, unknown> | null;
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`import — the patch variant for "${e.sheetName}" is not an object`);
      }
      if (typeof v.id !== "string" || !v.id || typeof v.name !== "string") {
        throw new Error(`import — the patch variant for "${e.sheetName}" has no id or name`);
      }
      // An `overrides` that is not a record would be written straight onto the
      // operator's sheet and read back by the patch editor as the endpoint map.
      if (v.overrides == null || typeof v.overrides !== "object" || Array.isArray(v.overrides)) {
        throw new Error(`import — the patch variant "${v.name}" has no override map`);
      }
    }
  }

  if (sd?.presets != null) {
    if (!Array.isArray(sd.presets)) throw new Error("import — presets is not a list");
    for (const raw of sd.presets as unknown[]) {
      const p = raw as Record<string, unknown> | null;
      if (!p || typeof p !== "object") throw new Error("import — a preset is not an object");
      if (typeof p.id !== "string" || !p.id || typeof p.name !== "string") {
        throw new Error("import — a preset has no id or name");
      }
      if (!Array.isArray(p.slots)) throw new Error(`import — preset "${p.name}" has no slot list`);
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

export interface ImportOptions {
  /** Which service type on THIS machine the plan's boards and patch assignment
   *  land under. Ignored when the file is not a plan export — a view export
   *  carries every type's boards and re-keying them would be a guess. */
  serviceTypeId?: string;
  /** What to do where the file and this machine both have something: the patch
   *  variant and its assignment, and a preset of the same id. Nothing else in a
   *  bundle can clash. Defaults to keeping what is here. */
  onClash?: "keep" | "replace";
}

export async function applyViewBundle(raw: unknown, opts: ImportOptions = {}): Promise<ImportReport> {
  assertBundle(raw);
  const bundle = raw;

  // Retyping. Only a plan export names a service type, so only a plan export can
  // be landed under a different one; for a view export the choice has no
  // meaning and is ignored rather than half-applied.
  const planned = bundle.plan;
  const targetType = planned ? (opts.serviceTypeId || planned.serviceTypeId) : null;
  const retypedFrom = planned && targetType && targetType !== planned.serviceTypeId
    ? planned.serviceTypeId
    : undefined;
  const onClash = opts.onClash ?? "keep";
  if (planned && retypedFrom) {
    // scrub() on all three: every one of them comes out of the uploaded FILE or
    // the request body, and /log is one record per line — a newline in any of
    // them forges an entry the operator cannot tell from one the server wrote.
    console.log(
      `[view-import] plan ${scrub(planned.serviceTypeName)} retyped from ${scrub(retypedFrom)} to ${scrub(targetType)}`,
    );
  }

  const existing = await viewsStore.load();

  // The same permanence rule createView follows, and the third place this
  // allocation lived. Scanning the live ids alone only avoided COLLISIONS: it
  // happily handed an imported view the id of one the operator had deleted,
  // which slots.json, bookmarks and QR codes all still point at.
  //
  // The whole remap runs inside the settings write queue so the floor is read,
  // advanced once per imported view and written as a single step. remapBundle is
  // synchronous CPU work, which is what makes that safe to do in there.
  const { views, viewIdMap, objectIdMap } = await settingsStore.allocateIds("view", (next) => {
    const usedIds = new Set(existing.map((v) => v.id));
    return remapBundle(bundle.views as View[], () => {
      const id = next([...usedIds]);
      usedIds.add(id);
      return id;
    });
  });

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
  let slotBoards = 0;
  let slotRows = 0;
  for (const [oldKey, byServiceType] of Object.entries(bundle.sideData?.slots ?? {})) {
    const newKey = objectIdMap.get(oldKey) ?? viewIdMap.get(oldKey);
    if (!newKey) continue;
    // The source type LAST, so that on a retyped "all"-scope plan its board is
    // the one that survives under the chosen type: two entries in the file can
    // land on the same key here, and the board the operator chose to export is
    // the one they meant.
    const entries = Object.entries(byServiceType ?? {})
      .sort((a, b) => Number(a[0] === retypedFrom) - Number(b[0] === retypedFrom));
    for (const [serviceTypeId, rows] of entries) {
      // Retyping moves ONLY the board the file's plan was exported for. Another
      // type's board (scope "all") belongs to that type on both machines.
      const landing = retypedFrom && serviceTypeId === retypedFrom ? targetType! : serviceTypeId;
      // A service type id is a KEY in the file, so it is whatever the file says.
      // slotsStore refuses a prototype-reaching key by throwing, which mid-import
      // would abort having already written the views — the operator would be told
      // it failed when it half-succeeded. Dropped and named instead, which is
      // what safe-key.ts prescribes for a bundle.
      if (!isSafeKey(landing)) {
        skipped.push(`slot rows for service type "${landing}"`);
        continue;
      }
      // Fresh slot ids, matching what duplicateView does: two views must never
      // share a slot row identity.
      const fresh = rows.map((r) => ({ ...r, id: randomUUID() }));
      // The bundle carries defaults only (see view-export), so this is where
      // they land — an imported view starts on its default board, with no
      // per-plan exception to inherit.
      //
      // NO CLASH BRANCH HERE, deliberately. `newKey` is a freshly minted view or
      // object id, so every board written here is a key nothing on this machine
      // has ever used. There is nothing of the operator's to overwrite, and the
      // Keep/Replace choice on the import screen says as much.
      await slotsStore.setDefault(newKey, landing, fresh);
      slotBoards++;
      slotRows += fresh.length;
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
    // One pass, in the same shape as mergeTargets below: `svHave` has to grow as
    // we go. Filtering the add-list up front instead let two incoming presets
    // sharing an id both pass the check and both get appended, leaving a
    // duplicate id in the store — the exact case mergeTargets guards against and
    // explains, re-implemented here without the guard.
    const add: typeof svIncoming = [];
    for (const l of svIncoming) {
      // A local preset of the same id wins, like a target does — but say so,
      // because the imported view then renders with the LOCAL columns.
      if (svHave.has(l.id)) skipped.push(`ScriptView preset "${l.name ?? l.id}" — kept the one already here`);
      else { svHave.add(l.id); add.push(l); }
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
      images.failed.push(`${ref}: ${errorMessage(err)}`);
    }
  }

  for (const ref of bundle.missingImages ?? []) {
    skipped.push(`${ref} — the layout points at it, but it was missing when exported`);
  }

  // ── Patch variants ────────────────────────────────────────────────────────
  //
  // The variant only, never the rig. A sheet's devices and endpoints are the
  // building's; a variant is an overlay of overrides on top of whatever this
  // machine's own patch says.
  const patchOutcomes: ImportReport["patchVariants"] = [];
  const incomingPatch = bundle.sideData?.patchVariants ?? [];
  if (incomingPatch.length && targetType) {
    // A CLONE. patchStore.load() hands back the DataStore's own cached object,
    // so mutating it and then deciding not to save (every "kept" outcome does)
    // would leave the running server holding a patch file that is not on disk.
    const file = structuredClone(await patchStore.load());
    let changed = false;
    for (const entry of incomingPatch) {
      // By id, then by name: a destination that built its own "Analog" sheet has
      // a different id for the same surface, and refusing on that alone would
      // make the section useless on every machine but a clone.
      const sheet = file.sheets.find((s) => s.id === entry.sheetId)
        ?? file.sheets.find((s) => s.name === entry.sheetName);
      const say = (outcome: ImportReport["patchVariants"][number]["outcome"]): void => {
        patchOutcomes.push({ sheetName: sheet?.name ?? entry.sheetName, variantName: entry.variant.name, outcome });
        console.log(
          `[view-import] patch variant "${scrub(entry.variant.name)}" ` +
          `on ${scrub(sheet?.name ?? entry.sheetName)}: ${scrub(outcome)}`,
        );
      };
      if (!sheet) {
        // Reported, not fatal: the views and boards are already correct, and a
        // refusal here would throw them away over one sheet.
        say("no-such-sheet");
        continue;
      }
      if (!isSafeKey(targetType)) {
        skipped.push(`the patch assignment for service type "${targetType}"`);
        continue;
      }
      sheet.assignments ??= { byServiceType: {}, byPlan: {} };
      const assignedNow = Object.hasOwn(sheet.assignments.byServiceType, targetType)
        ? sheet.assignments.byServiceType[targetType]
        : undefined;
      const clash = !!assignedNow && assignedNow !== entry.variant.id;
      if (clash && onClash === "keep") {
        // Nothing written at all — not even the variant. A variant nothing
        // points at is clutter in the patch editor, not a useful spare.
        say("kept");
        continue;
      }
      const at = sheet.variants.findIndex((v) => v.id === entry.variant.id);
      let outcome: ImportReport["patchVariants"][number]["outcome"];
      if (at === -1) {
        sheet.variants.push(entry.variant);
        outcome = "added";
      } else if (onClash === "replace") {
        sheet.variants[at] = entry.variant;
        outcome = "replaced";
      } else {
        outcome = assignedNow === entry.variant.id ? "kept" : "assigned";
      }
      sheet.assignments.byServiceType[targetType] = entry.variant.id;
      changed = true;
      say(outcome);
    }
    // One write for the whole file: patchStore.save replaces it wholesale, so
    // saving per sheet would be several read-modify-writes over the same bytes.
    if (changed) await patchStore.save(file);
  }

  // ── Presets ───────────────────────────────────────────────────────────────
  //
  // Global, matched by id. The slot ids INSIDE a preset stay as they are: a
  // preset is a template that mints fresh rows when it is applied, not a board,
  // so nothing on any screen shares an identity with them.
  const presets = { added: 0, kept: 0, replaced: 0 };
  const incomingPresets = bundle.sideData?.presets ?? [];
  if (incomingPresets.length) {
    const current = await presetsStore.load();
    const byId = new Map(current.map((p) => [p.id, p]));
    for (const p of incomingPresets) {
      if (!byId.has(p.id)) {
        byId.set(p.id, p);
        presets.added++;
      } else if (onClash === "replace") {
        byId.set(p.id, p);
        presets.replaced++;
      } else {
        presets.kept++;
      }
    }
    await presetsStore.save([...byId.values()]);
    // Scrubbed as one string: see the note on the same shape in plan-export.
    const tally = `${presets.added} added, ${presets.kept} kept, ${presets.replaced} replaced`;
    console.log(`[view-import] presets: ${scrub(tally)}`);
  }

  // The rebind list, from the same walk — and computed the same way the review
  // sheet computes it, so what was promised and what landed cannot disagree.
  //
  // EVERY root, not just the first. A view export has one root and `views[0]` is
  // it; a plan export has as many roots as the type has boards on, and walking
  // only the first under-reported every other root's hardware bindings — the
  // operator would find them on a Sunday instead of in the report.
  const rootIds = (bundle.roots?.length ? bundle.roots : [bundle.views[0]!.id])
    .map((id) => viewIdMap.get(id) ?? id)
    .filter((id) => named.some((v) => v.id === id));
  const rebind = collectRefsFrom(named, rootIds).unresolvable;

  return {
    views: reportViews,
    targetsAdded,
    targetsKept,
    images,
    rebind,
    skipped,
    ...(planned
      ? { plan: { serviceTypeId: targetType!, serviceTypeName: planned.serviceTypeName, ...(retypedFrom ? { retypedFrom } : {}) } }
      : {}),
    slotBoards,
    slotRows,
    patchVariants: patchOutcomes,
    presets,
  };
}
