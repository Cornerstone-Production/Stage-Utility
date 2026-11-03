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

import type { LayoutDTO, LayoutObject, ViewKind } from "../types/stage.js";
import { externKeyed } from "../types/extern-keyed.js";

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
// per-object side data (notes, a widget's board pointer) to the copy.
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

/**
 * The name a View gets when the operator does not type one.
 *
 * A record rather than a switch with a `default`, because the default was
 * answering for kinds it had never heard of: a new ServiceCue view and a new SPL
 * Rundown view were both created called "Slots". Every kind now has to be named
 * here, or the build fails.
 */
const DEFAULT_VIEW_NAMES: Record<ViewKind, string> = externKeyed({
  slots: "Slots",
  dashboard: "Dashboard",
  stage: "Stage",
  transcription: "Transcription",
  custom: "Custom",
  script: "ServiceCue",
  "spl-rundown": "SPL Rundown",
  calendar: "Calendar",
});

export function defaultViewName(kind: ViewKind): string {
  // The lookup can still miss: `kind` reaches here from a request body and from
  // views.json, either of which can carry a kind this build has never heard of.
  // "View", NOT "Slots" — a fallback naming an unrecognised kind after a real
  // one is the bug the record above replaced, and repeating it here would put it
  // back one line down.
  return DEFAULT_VIEW_NAMES[kind] ?? "View";
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
