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

/**
 * Every slots-grid object that draws ANOTHER view's slots, with the view it
 * draws.
 *
 * Its slots come from the source view, but its BOX does not: it is a free-dragged
 * rectangle on a custom layout, the same as an inline grid, so nothing
 * server-side knows the shape its photos will be drawn at. Only a standalone
 * slots display knows that. Resolving these separately is what lets them ask for
 * the whole image while the display keeps its column crop.
 *
 * `source` is optional and predates the inline option, so anything that is not
 * explicitly "inline" is a view-sourced grid — the same test the renderer makes.
 */
export function forEachViewSourcedSlotsGrid(
  views: View[],
  cb: (objectId: string, sourceViewId: string) => void,
): void {
  const walk = (objs: LayoutObject[]): void => {
    for (const o of objs) {
      const c = o.config;
      if (c.type === "slots-grid" && c.source !== "inline" && c.sourceViewId) cb(o.id, c.sourceViewId);
      if (o.children?.length) walk(o.children);
    }
  };
  for (const v of views) if (v.kind === "custom" && v.layout) walk(v.layout.objects);
}

/**
 * The name a View gets when the operator does not type one.
 *
 * A record rather than a switch with a `default`, because the default was
 * answering for kinds it had never heard of: a new Script view and a new SPL
 * Rundown view were both created called "Slots". Every kind now has to be named
 * here, or the build fails.
 */
const DEFAULT_VIEW_NAMES: Record<ViewKind, string> = {
  slots: "Slots",
  dashboard: "Dashboard",
  stage: "Stage",
  transcription: "Transcription",
  custom: "Custom",
  script: "Script",
  "spl-rundown": "SPL Rundown",
  calendar: "Calendar",
};

export function defaultViewName(kind: ViewKind): string {
  // The lookup can still miss: `kind` reaches here from a request body and from
  // views.json, either of which can carry a kind this build has never heard of.
  return DEFAULT_VIEW_NAMES[kind] ?? "Slots";
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
