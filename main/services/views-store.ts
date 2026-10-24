// Persists View definitions (content, decoupled from physical screens).
//
// Storage shape:  View[]  in views.json
//
// Slot data for slots-kind Views is NOT stored here — it lives in slots.json
// (see slots-store.ts) keyed by the View id, so Views migrated 1:1 from the old
// per-display model reuse their existing slot storage with no rewrite.

import type { View } from "../types/stage.js";
import { isSelectionList } from "../types/calendar.js";
import { isLayoutShape } from "../types/views.js";
import { DataStore } from "./data-store.js";
import { asArray, asObject, checked, namedEntries, optional, refuse } from "./restore-check.js";
import { adoptLegacyViewFields } from "./servicecue-legacy-names.js";

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
/**
 * A restored views.json, read through the legacy-field adoption a load applies
 * and held to what PATCH /api/views/:id checks of each field: a kind the app
 * has, a layout of the layout shape, `slotsLayout` an object or null, the
 * ServiceCue layout and NDI source text or null, the two flags booleans, the
 * calendar lists `{ id, name }` lists, the surface display or console.
 */
const restoreCheck = checked(async (raw) => {
  // Lazily: the route context imports more than a store should load.
  const { isDisplayKind } = await import("./routes/context.js");
  const views = adoptLegacyViewFields(asArray(raw, "the views"));
  const textOrNull = (v: unknown, what: string) => {
    if (v !== undefined && v !== null && typeof v !== "string") refuse(`${what} must be text or null`);
  };
  namedEntries(views, "the views").forEach((v, i) => {
    const what = `view "${String(v.name).slice(0, 40) || i + 1}"`;
    if (!isDisplayKind(v.kind)) refuse(`${what} has a kind this app does not have`);
    if (v.layout !== undefined && v.layout !== null && !isLayoutShape(v.layout)) refuse(`${what}'s layout is not a layout`);
    if (v.slotsLayout !== undefined && v.slotsLayout !== null) asObject(v.slotsLayout, `${what}'s slots layout`);
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
  return views;
});

export const viewsStore = new DataStore<View[]>("views.json", [], "config", {
  restoreCheck,
  // A view saved before ServiceCue was renamed names its column preset with the old
  // field; it is read as the new one and written as the new one on the next save.
  normalize: adoptLegacyViewFields,
});
