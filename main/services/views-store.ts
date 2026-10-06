// Persists View definitions (content, decoupled from physical screens).
//
// Storage shape:  View[]  in views.json
//
// Slot data for slots-kind Views is NOT stored here — it lives in slots.json
// (see slots-store.ts) keyed by the View id, so Views migrated 1:1 from the old
// per-display model reuse their existing slot storage with no rewrite.

import type { View } from "../types/stage.js";
import { DataStore } from "./data-store.js";
import { adoptLegacyViewFields } from "./servicecue-legacy-names.js";

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
export const viewsStore = new DataStore<View[]>("views.json", [], "config", {
  // A view saved before ServiceCue was renamed names its column preset with the old
  // field; it is read as the new one and written as the new one on the next save.
  normalize: adoptLegacyViewFields,
});
