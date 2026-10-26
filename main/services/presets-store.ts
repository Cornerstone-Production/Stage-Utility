// Persists named slot presets (global — not per service type).

import type { SlotPreset } from "../types/stage.js";
import { DataStore } from "./data-store.js";
import { asArray, checked, namedEntries, refuse } from "./restore-check.js";

/** The preset routes: a name that is not blank, and a list of slots. */
const restoreCheck = checked((raw) => {
  namedEntries(raw, "the presets").forEach((p, i) => {
    if (!(p.name as string).trim()) refuse(`preset ${i + 1} has no name`);
    asArray(p.slots, `preset ${i + 1}'s slots`);
  });
  return raw;
});

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
export const presetsStore = new DataStore<SlotPreset[]>("presets.json", [], "config", { restoreCheck });
