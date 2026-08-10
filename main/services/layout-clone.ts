// layout-clone.ts — duplicating a custom layout without duplicating its ids.
//
// Copying a View, a template or a group means copying a whole object tree, and
// every object in it needs a fresh id: two Views sharing child object ids collide
// the moment either is edited. That has to happen at every depth, which is the
// part a shallow copy quietly gets wrong.
//
// Lifted out of stage-controller.ts (2,429 lines) — pure functions with no
// controller state, which is exactly what should not have been living inside it.

import { randomUUID } from "node:crypto";

import type { LayoutDTO, LayoutObject, View, ViewKind } from "../types/stage.js";

// Deep-clone an object and its whole subtree, minting a fresh id at every depth.
// Nested children must be cloned too, or duplicated Views/templates would share
// child object references and collide on child ids.
export function cloneLayoutObject(o: LayoutObject): LayoutObject {
  return {
    ...o,
    id: randomUUID(),
    style: o.style ? { ...o.style } : undefined,
    config: { ...o.config },
    children: o.children?.map(cloneLayoutObject),
  };
}

export function cloneLayout(l: LayoutDTO): LayoutDTO {
  return {
    version: 1,
    canvas: { ...l.canvas },
    objects: l.objects.map(cloneLayoutObject),
  };
}

// Like cloneLayoutObject, but records each old→new id so callers can carry
// per-object side data (e.g. inline mic-slots stored by object id) to the copy.
function cloneLayoutObjectMapped(o: LayoutObject, idMap: Map<string, string>): LayoutObject {
  const id = randomUUID();
  idMap.set(o.id, id);
  return {
    ...o,
    id,
    style: o.style ? { ...o.style } : undefined,
    config: { ...o.config },
    children: o.children?.map((c) => cloneLayoutObjectMapped(c, idMap)),
  };
}

export function cloneLayoutWithMap(l: LayoutDTO): { layout: LayoutDTO; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const layout: LayoutDTO = { version: 1, canvas: { ...l.canvas }, objects: l.objects.map((o) => cloneLayoutObjectMapped(o, idMap)) };
  return { layout, idMap };
}

// Visit every inline mic-slots object id across all custom views' layouts (a
// `slots-grid` with source "inline"); recurses into container children.
export function forEachInlineSlotsGrid(views: View[], cb: (objectId: string) => void): void {
  const walk = (objs: LayoutObject[]): void => {
    for (const o of objs) {
      if (o.config.type === "slots-grid" && o.config.source === "inline") cb(o.id);
      if (o.children?.length) walk(o.children);
    }
  };
  for (const v of views) if (v.kind === "custom" && v.layout) walk(v.layout.objects);
}

export function defaultViewName(kind: ViewKind): string {
  switch (kind) {
    case "dashboard": return "Dashboard";
    case "stage": return "Stage";
    case "transcription": return "Transcription";
    case "custom": return "Custom";
    default: return "Slots";
  }
}

/** A sensible starting layout for a new custom View — proves the schema and
 *  gives the editor something to manipulate (clock, countdown, slide text). */
// A new custom view starts BLANK — the operator builds from scratch, or picks a
// starter template in the create dialog / editor. (It used to seed 5 objects,
// which meant every new custom layout had to be cleared by hand first.)
export function defaultCustomLayout(): LayoutDTO {
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null },
    objects: [],
  };
}
