// Persists the CONFIG portion of OSC targets (id, name, enabled, config).
// Runtime fields (connection/message) are never persisted.

import type { OscTargetConfig } from "../types/osc.js";
import { DataStore } from "./data-store.js";
import { checked, targetEntries } from "./restore-check.js";

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
export const oscStore = new DataStore<OscTargetConfig[]>("osc-targets.json", [], "config", {
  // PATCH /api/osc/targets/:id: a text name, a boolean enabled, an object config.
  restoreCheck: checked((raw) => targetEntries(raw, "the OSC targets")),
});
