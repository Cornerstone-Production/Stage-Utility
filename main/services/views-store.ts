// Persists View definitions (content, decoupled from physical screens).
//
// Storage shape:  View[]  in views.json
//
// Slot data for slots-kind Views is NOT stored here — it lives in slots.json
// (see slots-store.ts) keyed by the View id, so Views migrated 1:1 from the old
// per-display model reuse their existing slot storage with no rewrite.

import type { View } from "../types/stage.js";
import { isSelectionList } from "../types/calendar.js";
import { isDisplayKind, isLayoutShape, isSlotsLayoutValue } from "../types/views.js";
import { DataStore } from "./data-store.js";
import { asArray, checked, namedEntries, optional, refuse, textOrNull, uniqueIds } from "./restore-check.js";
import { adoptLegacyViewFields } from "./servicecue-legacy-names.js";
import { isSafeKey } from "./safe-key.js";

/**
 * A restored views.json, read through the legacy-field adoption a load applies
 * and held to what PATCH /api/views/:id checks of each field, through the same
 * predicates: a kind the app has (isDisplayKind), a layout of the layout shape,
 * `slotsLayout` an object or null, the ServiceCue layout and NDI source text or
 * null, the two flags booleans, the calendar lists `{ id, name }` lists, the
 * surface display or console. No id twice.
 */
const restoreCheck = checked((raw) => {
  const views = adoptLegacyViewFields(asArray(raw, "the views"));
  const list = namedEntries(views, "the views");
  list.forEach((v, i) => {
    const what = `view "${String(v.name).slice(0, 40) || i + 1}"`;
    // slots.json, notes and screens key on a view's id.
    if (!isSafeKey(v.id as string)) refuse(`${what}'s id is not allowed`);
    if (!isDisplayKind(v.kind)) refuse(`${what} has a kind this app does not have`);
    if (v.layout !== undefined && v.layout !== null && !isLayoutShape(v.layout)) refuse(`${what}'s layout is not a layout`);
    if (v.slotsLayout !== undefined && !isSlotsLayoutValue(v.slotsLayout)) refuse(`${what}'s slots layout must be an object or null`);
    textOrNull(v.serviceCueLayoutId, `${what}'s ServiceCue layout`);
    textOrNull(v.ndiSource, `${what}'s NDI source`);
    optional(v.hideChrome, "boolean", `${what}'s hideChrome`);
    optional(v.showInSidebar, "boolean", `${what}'s showInSidebar`);
    for (const k of ["calendarSources", "calendarTags"] as const) {
      if (v[k] !== undefined && !isSelectionList(v[k])) refuse(`${what}'s ${k} must be a list of { id, name }`);
    }
    if (v.surface !== undefined && v.surface !== "display" && v.surface !== "console") {
      refuse(`${what}'s surface must be display or console`);
    }
  });
  uniqueIds(list, "the views");
  return views;
});

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
export const viewsStore = new DataStore<View[]>("views.json", [], "config", {
  restoreCheck,
  // A view saved before ServiceCue was renamed names its column preset with the old
  // field; it is read as the new one and written as the new one on the next save.
  normalize: adoptLegacyViewFields,
});
