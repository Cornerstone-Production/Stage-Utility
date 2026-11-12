// servicecue-layouts-model.ts — what the layouts page computes, apart from React.
//
// A layout's columns are Clock, Time, Item, its roles in order, Max SPL: the order the
// rundown draws them (servicecue-columns.tsx). Clock, Time and Max SPL are show flags
// with a fixed place; only the roles move. Item is always drawn. Everything the page
// says about that (the collapsed summary, the tray of what is not in a layout, the
// confirms, the notice) is built here, so a test can read it without a page.

import { layoutNameKey } from "@main/services/servicecue-slug";
import type { ServiceCueLayout } from "../../../main/types/pco.js";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import { freeLayoutName } from "./servicecue-layout-names";

/** The columns a layout stores as a show flag, each with a fixed place in the row. */
export type FixedKey = "showClock" | "showLength" | "showMaxSpl";

export const FIXED_LABEL: Record<FixedKey, string> = { showClock: "Clock", showLength: "Time", showMaxSpl: "Max SPL" };

/** Is a fixed column on? Max SPL is opt-in (a layout saved before it existed has no
 *  column of dashes); Clock and Time are opt-out, so only `false` hides them. */
export function fixedOn(l: ServiceCueLayout, key: FixedKey): boolean {
  return key === "showMaxSpl" ? l.showMaxSpl === true : l[key] !== false;
}

/** What a layout can show under an item's title, in the page's order. Opt-out. */
export const UNDER_TITLE = [
  { key: "showKey", label: "Song key" },
  { key: "showBpm", label: "BPM" },
  { key: "showMeter", label: "Time signature" },
  { key: "showArrangement", label: "Arrangement" },
  { key: "showItemNotes", label: "Item notes" },
] as const satisfies readonly { key: keyof ServiceCueLayout; label: string }[];

/** What a layout can show in its footer. Opt-out. */
export const FOOTER = [{ key: "showTotalTime", label: "Total time" }] as const satisfies readonly {
  key: keyof ServiceCueLayout;
  label: string;
}[];

export type ToggleKey = (typeof UNDER_TITLE)[number]["key"] | (typeof FOOTER)[number]["key"];

export const toggleOn = (l: ServiceCueLayout, key: ToggleKey): boolean => l[key] !== false;

const norm = (s: string) => s.trim().toLowerCase();

/** Layouts in the landing page's order. */
export const byOrder = <T extends { order: number }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.order - b.order);

/** "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A layout's roles in column order. An id no role has any more is left out. */
export function layoutRoles(l: ServiceCueLayout, roles: readonly CategoryRole[]): CategoryRole[] {
  const byId = new Map(roles.map((r) => [r.id, r]));
  return (l.columnRoles ?? []).flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
}

/** Every column a layout draws, by name, in the rundown's order. */
export function columnSummary(l: ServiceCueLayout, roles: readonly CategoryRole[]): string[] {
  return [
    ...(fixedOn(l, "showClock") ? ["Clock"] : []),
    ...(fixedOn(l, "showLength") ? ["Time"] : []),
    "Item",
    ...layoutRoles(l, roles).map((r) => r.name),
    ...(fixedOn(l, "showMaxSpl") ? ["Max SPL"] : []),
  ];
}

export type TrayItem = { kind: "fixed"; key: FixedKey; name: string } | { kind: "role"; id: string; name: string };

/** What could be added to a layout: Clock and Time if off, every role it lacks, Max SPL if off. */
export function trayItems(l: ServiceCueLayout, roles: readonly CategoryRole[]): TrayItem[] {
  const fixed = (key: FixedKey): TrayItem[] => (fixedOn(l, key) ? [] : [{ kind: "fixed", key, name: FIXED_LABEL[key] }]);
  const shown = new Set(l.columnRoles ?? []);
  return [
    ...fixed("showClock"),
    ...fixed("showLength"),
    ...roles.filter((r) => !shown.has(r.id)).map((r): TrayItem => ({ kind: "role", id: r.id, name: r.name })),
    ...fixed("showMaxSpl"),
  ];
}

/** `item` moved to `index` of the list without it. */
export function moveTo<T>(list: readonly T[], item: T, index: number): T[] {
  const out = list.filter((x) => x !== item);
  out.splice(Math.max(0, Math.min(index, out.length)), 0, item);
  return out;
}

/** One change to a layout's Columns row. `index` counts role columns, the moved one left out. */
export type ColumnChange =
  | { kind: "move-role"; roleId: string; index: number }
  | { kind: "add-role"; roleId: string; index?: number }
  | { kind: "remove-role"; roleId: string }
  | { kind: "set-fixed"; key: FixedKey; on: boolean };

/** The patch a Columns change makes to the layout as it is when the change saves. */
export function columnPatch(l: ServiceCueLayout, c: ColumnChange): Partial<ServiceCueLayout> {
  const cols = l.columnRoles ?? [];
  switch (c.kind) {
    case "move-role":
      return { columnRoles: moveTo(cols, c.roleId, c.index) };
    case "add-role":
      return { columnRoles: moveTo(cols, c.roleId, c.index ?? cols.length) };
    case "remove-role":
      // A layout must not keep tinting rows by a role it no longer shows.
      return { columnRoles: cols.filter((id) => id !== c.roleId), ...(l.accentRole === c.roleId ? { accentRole: null } : {}) };
    case "set-fixed":
      return { [c.key]: c.on };
  }
}

/** The list in `ids` order, each `order` renumbered from 0. Ids not in the list are ignored. */
export function reorderLayouts(list: readonly ServiceCueLayout[], ids: readonly string[]): ServiceCueLayout[] {
  const byId = new Map(list.map((l) => [l.id, l]));
  const placed = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const rest = byOrder(list.filter((l) => !ids.includes(l.id)));
  return [...placed, ...rest].map((l, order) => ({ ...l, order }));
}

/** A new layout: no roles, Clock and Time on, Max SPL off, the first free "Layout N". */
export function newLayout(list: readonly ServiceCueLayout[], id: string): ServiceCueLayout {
  return {
    id,
    name: freeLayoutName([...list]),
    order: list.length ? Math.max(...list.map((l) => l.order)) + 1 : 0,
    columnRoles: [],
    showMaxSpl: false,
    autoNamed: true, // its first rename moves its address; see ServiceCueLayout.autoNamed
  };
}

/** "<name> copy", then "<name> copy 2" … whichever no layout is called, as the server compares names. */
export function copyName(name: string, list: readonly ServiceCueLayout[]): string {
  const taken = new Set(list.map((l) => layoutNameKey(l.name)));
  const base = `${name} copy`;
  let out = base;
  for (let n = 2; taken.has(layoutNameKey(out)); n++) out = `${base} ${n}`;
  return out;
}

/** The list with a copy of layout `id` right after it, under a free name and its own address. */
export function duplicateLayout(list: readonly ServiceCueLayout[], id: string, newId: string): ServiceCueLayout[] {
  const sorted = byOrder(list);
  const i = sorted.findIndex((l) => l.id === id);
  if (i < 0) return [...list];
  const { slug: _slug, ...rest } = sorted[i];
  // Named by the page, not the operator, so its first rename moves its address too.
  const copy: ServiceCueLayout = { ...rest, id: newId, name: copyName(sorted[i].name, sorted), autoNamed: true };
  return [...sorted.slice(0, i + 1), copy, ...sorted.slice(i + 1)].map((l, order) => ({ ...l, order }));
}

/** Text with some of it bold, for a confirm. */
export type Rich = (string | { b: string })[];

export const plainText = (r: Rich): string => r.map((p) => (typeof p === "string" ? p : p.b)).join("");

/** What deleting a layout does to the screens set to it. `views` is null until known. */
export function deleteLayoutBody(
  layout: Pick<ServiceCueLayout, "id">,
  views: readonly { name: string; kind?: string; serviceCueLayoutId?: string | null }[] | null | undefined,
): Rich {
  // A tablet opened at the layout's address is set to nothing the server knows of,
  // so it is said apart from the screens: it shows All columns too.
  const tablet = " A tablet opened at its address will show All columns too.";
  if (!views) return [`Screens using it will show All columns.${tablet}`];
  // Only a ServiceCue view draws a layout. A view changed to another kind keeps the id
  // it had, and shows nothing of it.
  const users = views.filter((v) => v.kind === "script" && v.serviceCueLayoutId === layout.id).map((v) => v.name);
  if (users.length === 0) return [`No screens use this layout.${tablet}`];
  return [
    { b: listOf(users) },
    users.length === 1 ? " uses this layout. It will show All columns." : " use this layout. They will show All columns.",
    tablet,
  ];
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** What deleting a role takes with it: the layouts it is a column in, those it tints, its categories. */
export function deleteRoleBody(role: CategoryRole, layouts: readonly ServiceCueLayout[]): Rich {
  const sorted = byOrder(layouts);
  const using = sorted.filter((l) => (l.columnRoles ?? []).includes(role.id)).map((l) => l.name);
  const tint = sorted.filter((l) => l.rowColor === "category" && l.accentRole === role.id).map((l) => l.name);
  const n = using.length;
  const out: Rich = n === 0
    ? ["No layout has ", { b: role.name }, " as a column."]
    : [
        { b: role.name },
        " is a column in ",
        { b: listOf(using) },
        `. Deleting it removes it from ${n === 1 ? "that layout" : n === 2 ? "both" : `all ${NUMBER_WORDS[n] ?? n}`}.`,
      ];
  if (tint.length) out.push(` Rows in ${listOf(tint)} stop being tinted by it.`);
  const m = role.members.length;
  if (m) {
    out.push(
      ` ${listOf(role.members)} ${m === 1 ? "goes" : "go"} back to Categories in no role, and still ${m === 1 ? "appears" : "appear"} under All columns.`,
    );
  }
  return out;
}

/** Categories on `typeIds`, in each type's order, that no role claims; types with none left out. */
export function unassignedByType(
  roles: readonly CategoryRole[],
  typeIds: readonly string[],
  catsByType: ReadonlyMap<string, readonly string[]>,
): { typeId: string; cats: string[] }[] {
  const claimed = new Set(roles.flatMap((r) => r.members.map(norm)));
  return typeIds
    .map((typeId) => ({ typeId, cats: (catsByType.get(typeId) ?? []).filter((c) => !claimed.has(norm(c))) }))
    .filter((g) => g.cats.length > 0);
}

/** The same, one entry per name (the first spelling wins), with every type it came from. */
export function unassignedDistinct(groups: readonly { typeId: string; cats: string[] }[]): { name: string; typeIds: string[] }[] {
  const byKey = new Map<string, { name: string; typeIds: string[] }>();
  for (const g of groups) {
    for (const c of g.cats) {
      const entry = byKey.get(norm(c)) ?? { name: c, typeIds: [] };
      entry.typeIds.push(g.typeId);
      byKey.set(norm(c), entry);
    }
  }
  return [...byKey.values()];
}

/** The top-of-page line naming the categories no layout can show, in three parts: the
 *  bold lead, the rest of the sentence, and the quieter reassurance after it. */
export function noticeText(groups: readonly { typeName: string; cats: string[] }[]): { lead: string; rest: string; still: string } {
  const parts = groups.map((g) => `${listOf(g.cats)} from ${g.typeName}`);
  const n = groups.reduce((sum, g) => sum + g.cats.length, 0);
  const one = n === 1;
  return {
    lead: `${parts.join(groups.some((g) => g.cats.length > 1) ? ", and " : " and ")} ${one ? "is" : "are"} in no role`,
    rest: `, so no layout can show ${one ? "it" : "them"} as a column.`,
    still: one ? "It still appears under All columns." : "They still appear under All columns.",
  };
}

/** Which categories sit in more than one role, each with the roles claiming it. */
export function ambiguousCategories(roles: readonly CategoryRole[]): { name: string; roles: string[] }[] {
  const byKey = new Map<string, { name: string; roles: string[] }>();
  for (const r of roles) {
    for (const m of r.members) {
      const entry = byKey.get(norm(m)) ?? { name: m, roles: [] };
      entry.roles.push(r.name);
      byKey.set(norm(m), entry);
    }
  }
  return [...byKey.values()].filter((e) => e.roles.length > 1);
}

/** Does a role have a member among these categories? A role with none draws no column. */
export function roleApplies(role: CategoryRole, cats: readonly string[]): boolean {
  const have = new Set(cats.map(norm));
  return role.members.some((m) => have.has(norm(m)));
}
