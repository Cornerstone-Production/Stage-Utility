// layout-library.ts — the saved-layout and saved-group libraries.
//
// Templates replace a whole custom layout; groups insert one object subtree into
// an existing one. Both are global (not per service type or view), and both mint
// fresh ids on save, so a library copy can never share child object ids with the
// view it was captured from.
//
// Free functions, not controller methods. These were seven methods on
// StageController that touched no controller state at all — every one loads a
// store, changes a list, saves it. Routing them through the controller only
// meant a wrapper to keep in step, so the routes call them directly.

import { randomUUID } from "node:crypto";

import type { LayoutDTO, LayoutGroup, LayoutObject, LayoutTemplate } from "../types/stage.js";
import { cloneLayout, cloneLayoutObject } from "./layout-clone.js";
import { layoutGroupsStore } from "./layout-groups-store.js";
import { layoutTemplatesStore } from "./layout-templates-store.js";
import { scrub } from "./scrub.js";

export async function listLayoutTemplates(): Promise<LayoutTemplate[]> {
  return layoutTemplatesStore.load();
}

export async function saveLayoutTemplate(name: string, layout: LayoutDTO): Promise<LayoutTemplate[]> {
  const list = await layoutTemplatesStore.load();
  const tpl: LayoutTemplate = {
    id: randomUUID(),
    name: name.trim() || "Layout",
    layout: cloneLayout(layout),
    createdAt: new Date().toISOString(),
  };
  console.log(`[stage-controller] saveLayoutTemplate "${scrub(tpl.name)}" (${tpl.layout.objects.length} objects)`);
  const updated = [...list, tpl];
  await layoutTemplatesStore.save(updated);
  return updated;
}

export async function updateLayoutTemplate(id: string, patch: { name?: string; layout?: LayoutDTO }): Promise<LayoutTemplate[]> {
  const list = await layoutTemplatesStore.load();
  if (!list.find((t) => t.id === id)) throw new Error(`layout template ${id} not found`);
  const updated = list.map((t) =>
    t.id === id
      ? {
          ...t,
          name: patch.name !== undefined ? (patch.name.trim() || t.name) : t.name,
          layout: patch.layout ? cloneLayout(patch.layout) : t.layout,
        }
      : t,
  );
  console.log(`[stage-controller] updateLayoutTemplate ${id}`);
  await layoutTemplatesStore.save(updated);
  return updated;
}

export async function deleteLayoutTemplate(id: string): Promise<LayoutTemplate[]> {
  console.log(`[stage-controller] deleteLayoutTemplate ${id}`);
  const list = await layoutTemplatesStore.load();
  const updated = list.filter((t) => t.id !== id);
  await layoutTemplatesStore.save(updated);
  return updated;
}

// ── Layout groups (reusable object/container library) ───────────────────
// Like templates, but a single object subtree the operator inserts into a view
// rather than a whole-layout replace. (Inline mic-slot data is per-object/
// per-service-type and is NOT carried — same as templates; re-pick slots after.)

export async function listLayoutGroups(): Promise<LayoutGroup[]> {
  return layoutGroupsStore.load();
}

export async function saveLayoutGroup(name: string, object: LayoutObject): Promise<LayoutGroup[]> {
  const list = await layoutGroupsStore.load();
  const group: LayoutGroup = {
    id: randomUUID(),
    name: name.trim() || "Group",
    object: cloneLayoutObject(object), // fresh ids so the library copy is isolated
    createdAt: new Date().toISOString(),
  };
  console.log(`[stage-controller] saveLayoutGroup "${scrub(group.name)}" (${scrub((group.object.children?.length ?? 0))} children)`);
  const updated = [...list, group];
  await layoutGroupsStore.save(updated);
  return updated;
}

export async function deleteLayoutGroup(id: string): Promise<LayoutGroup[]> {
  console.log(`[stage-controller] deleteLayoutGroup ${id}`);
  const list = await layoutGroupsStore.load();
  const updated = list.filter((g) => g.id !== id);
  await layoutGroupsStore.save(updated);
  return updated;
}
