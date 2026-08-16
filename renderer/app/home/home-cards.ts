// What Home shows, in what order, and how the operator changes it.
//
// Pure. Home's editor is presence and order and nothing else, so all of it is
// array work over the Home View's object list — testable without rendering, and
// without a server.
//
// The View's GEOMETRY is deliberately unused here. See main/services/home-view.ts
// for why Home keeps a layout it does not lay out.

import type { LayoutObject, LayoutObjectConfig } from "@main/types/views";
import { LAYOUT_OBJECTS } from "../../main/layout-objects";
import type { HomeMode } from "./home-mode";

/**
 * The card types Home draws — DERIVED from the object config union, not listed
 * beside it.
 *
 * Every `home-*` member of LayoutObjectConfig is a Home card, so adding a fifth
 * one cannot leave Home silently ignoring it: WHEN below is a Record over this
 * type, and a missing entry fails `tsc`. A hand-kept parallel list would have
 * gone stale the first time somebody added a card and forgot this file. The same
 * `Extract` backs `defaultHomeLayout`.
 */
export type HomeCardType = Extract<LayoutObjectConfig, { type: `home-${string}` }>["type"];

/**
 * The mood each card belongs to.
 *
 * Home has two: a service is running, or it is Thursday. A running timer is
 * noise on a Thursday and a readiness checklist is noise mid-service, so a card
 * is on the page in one mood and absent in the other. This preserves the
 * behaviour the two fixed panels had — it is not a new rule.
 *
 * This object is also where HOME_CARD_TYPES gets its ORDER, which is the order
 * a switched-off card is offered back in.
 */
const WHEN: Record<HomeCardType, HomeMode> = {
  "home-live-status": "live",
  "home-next-service": "idle",
  "home-readiness": "idle",
  "home-recent-services": "idle",
};

/** Derived from WHEN's keys, so the two cannot disagree about what exists. */
export const HOME_CARD_TYPES = Object.keys(WHEN) as HomeCardType[];

/** Said in the editor, so a card that is present but not showing right now reads
 *  as scheduled rather than broken. One line per mood, not one per card — a card
 *  whose hint contradicts its mood is then unrepresentable. */
const HINT: Record<HomeMode, string> = {
  live: "While a service is running",
  idle: "The rest of the week",
};

interface HomeCardSpec {
  type: HomeCardType;
  /** The label the registry already carries. Not a second copy. */
  label: string;
  when: HomeMode;
  hint: string;
}

function cardSpec(type: HomeCardType): HomeCardSpec {
  return { type, label: LAYOUT_OBJECTS[type].label, when: WHEN[type], hint: HINT[WHEN[type]] };
}

/** True for the types Home knows how to draw. Anything else in Home's layout is
 *  a leftover from when Home was edited on a canvas — kept, never dropped. */
export function isHomeCard(type: string): type is HomeCardType {
  return type in WHEN;
}

/**
 * The card objects in the layout, keyed by type, in the layout's order.
 *
 * One of each: a duplicate would render the same card twice and give the editor
 * two rows that toggle each other. A Map because insertion order IS the card
 * order — the same walk backs both `cardOrder` and `reorderCards`, which were
 * two spellings of it.
 */
function cardsByType(objects: readonly LayoutObject[]): Map<HomeCardType, LayoutObject> {
  const out = new Map<HomeCardType, LayoutObject>();
  for (const o of objects) {
    const t = o.config.type;
    if (isHomeCard(t) && !out.has(t)) out.set(t, o);
  }
  return out;
}

/** Home's cards, in the layout's order. Non-card objects are skipped. */
export function cardOrder(objects: readonly LayoutObject[]): HomeCardType[] {
  return [...cardsByType(objects).keys()];
}

/** The cards actually on the page right now. */
export function visibleCards(objects: readonly LayoutObject[], mode: HomeMode): HomeCardType[] {
  return cardOrder(objects).filter((t) => WHEN[t] === mode);
}

export interface HomeCardRow extends HomeCardSpec {
  /** On the page (when its mood comes round), or switched off. */
  present: boolean;
}

/**
 * The editor's rows: every card Home has, present ones first in their stored
 * order, then the ones switched off.
 *
 * Absent cards are listed too — an editor that only shows what is already there
 * gives you no way to put something back, which is how a "hide" becomes a
 * delete.
 */
export function cardRows(objects: readonly LayoutObject[]): HomeCardRow[] {
  const present = cardOrder(objects);
  const rest = HOME_CARD_TYPES.filter((t) => !present.includes(t));
  return [
    ...present.map((t) => ({ ...cardSpec(t), present: true })),
    ...rest.map((t) => ({ ...cardSpec(t), present: false })),
  ];
}

/** A fresh object for a card. Geometry is filled in because the type demands it,
 *  not because Home reads it. The id is the type — one card of each kind, so
 *  there is nothing else it could usefully be, and it matches what
 *  `defaultHomeLayout` seeds. */
function makeCard(type: HomeCardType): LayoutObject {
  return {
    id: type,
    x: 0.04,
    y: 0.06,
    w: 0.92,
    h: 0.2,
    z: 1,
    config: LAYOUT_OBJECTS[type].config() as LayoutObjectConfig,
    style: {},
  } as LayoutObject;
}

/**
 * Switch a card on or off.
 *
 * Off removes every object of that type; on appends one at the end, which is
 * where a newly added thing belongs — anywhere else and it appears somewhere the
 * operator was not looking. Non-card objects are untouched.
 */
export function toggleCard(objects: readonly LayoutObject[], type: HomeCardType): LayoutObject[] {
  const has = objects.some((o) => o.config.type === type);
  if (has) return objects.filter((o) => o.config.type !== type);
  return [...objects, makeCard(type)];
}

/**
 * Move a present card from one position to another, both indexes into the
 * PRESENT card list rather than into the raw object array — the editor's rows
 * are cards, and the array may hold strays between them.
 *
 * Out-of-range indexes return the list unchanged rather than throwing: a drag
 * that ends on nothing is a no-op, not an error.
 */
export function reorderCards(
  objects: readonly LayoutObject[],
  from: number,
  to: number,
): LayoutObject[] {
  const order = cardOrder(objects);
  if (from < 0 || to < 0 || from >= order.length || to >= order.length || from === to) {
    return [...objects];
  }
  const next = order.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);

  // Rebuilt from the objects that are already there, so every card keeps its own
  // identity — this reorders, it does not recreate.
  //
  // Nothing is dropped. The drawn card of each type goes first, in the new
  // order, and everything else — a second object of a type Home already draws,
  // an object Home cannot draw at all — is appended untouched. Neither is
  // reachable from this editor, but both are reachable from a restored snapshot,
  // and deleting an operator's data to tidy a list is not this function's call.
  const drawn = cardsByType(objects);
  const kept = new Set(drawn.values());
  return [...next.map((t) => drawn.get(t)!), ...objects.filter((o) => !kept.has(o))];
}
