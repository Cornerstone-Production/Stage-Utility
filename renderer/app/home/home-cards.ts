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

/** The card types Home draws. A subset of the shared widget registry — Home has
 *  no widget set of its own, which is the whole point of Phase 6. */
export const HOME_CARD_TYPES = [
  "home-live-status",
  "home-next-service",
  "home-readiness",
  "home-recent-services",
] as const;

export type HomeCardType = (typeof HOME_CARD_TYPES)[number];

export interface HomeCardSpec {
  type: HomeCardType;
  /** The label the registry already carries. Not a second copy. */
  label: string;
  /**
   * The mood this card belongs to.
   *
   * Home has two: a service is running, or it is Thursday. A running timer is
   * noise on a Thursday and a readiness checklist is noise mid-service, so a
   * card is on the page in one mood and absent in the other. This preserves the
   * behaviour the two fixed panels had — it is not a new rule.
   */
  when: HomeMode;
  /** Said in the editor, so a card that is present but not showing right now
   *  reads as scheduled rather than broken. */
  hint: string;
}

const WHEN: Record<HomeCardType, { when: HomeMode; hint: string }> = {
  "home-live-status": { when: "live", hint: "While a service is running" },
  "home-next-service": { when: "idle", hint: "The rest of the week" },
  "home-readiness": { when: "idle", hint: "The rest of the week" },
  "home-recent-services": { when: "idle", hint: "The rest of the week" },
};

export function cardSpec(type: HomeCardType): HomeCardSpec {
  return { type, label: LAYOUT_OBJECTS[type].label, ...WHEN[type] };
}

/** True for the types Home knows how to draw. Anything else in Home's layout is
 *  a leftover from when Home was edited on a canvas — kept, not rendered, and
 *  named in the editor rather than vanishing. */
export function isHomeCard(type: string): type is HomeCardType {
  return (HOME_CARD_TYPES as readonly string[]).includes(type);
}

/** Home's cards, in the layout's order, presence and all. Non-card objects are
 *  skipped. */
export function cardOrder(objects: readonly LayoutObject[]): HomeCardType[] {
  const seen = new Set<HomeCardType>();
  const out: HomeCardType[] = [];
  for (const o of objects) {
    const t = o.config.type;
    // One of each. A duplicate would render the same card twice and give the
    // editor two rows that toggle each other.
    if (isHomeCard(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** The cards actually on the page right now. */
export function visibleCards(objects: readonly LayoutObject[], mode: HomeMode): HomeCardType[] {
  return cardOrder(objects).filter((t) => WHEN[t].when === mode);
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

/** Objects in Home's layout that Home does not draw, by type. */
export function strayTypes(objects: readonly LayoutObject[]): string[] {
  return [...new Set(objects.filter((o) => !isHomeCard(o.config.type)).map((o) => o.config.type))];
}

/** A fresh object for a card. Geometry is filled in because the type demands it,
 *  not because Home reads it. */
function makeCard(type: HomeCardType): LayoutObject {
  return {
    id: `home-${type}`,
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
  // identity — this reorders, it does not recreate. Cards first in the new
  // order, then anything Home does not draw; a duplicate of a card type is
  // dropped, matching what cardOrder already renders.
  const first = new Map<string, LayoutObject>();
  for (const o of objects) {
    if (isHomeCard(o.config.type) && !first.has(o.config.type)) first.set(o.config.type, o);
  }
  return [
    ...next.map((t) => first.get(t)!),
    ...objects.filter((o) => !isHomeCard(o.config.type)),
  ];
}
