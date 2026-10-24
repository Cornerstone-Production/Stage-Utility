// Persists named, reusable custom-layout templates (a library, global — not per
// service type or view).

import type { LayoutTemplate } from "../types/stage.js";
import { isLayoutShape } from "../types/views.js";
import { DataStore } from "./data-store.js";
import { checked, namedEntries, refuse } from "./restore-check.js";

/** POST /api/layout-templates: a name, and isLayoutShape. */
const restoreCheck = checked((raw) => {
  namedEntries(raw, "the layout templates").forEach((t, i) => {
    if (!isLayoutShape(t.layout)) refuse(`layout template ${i + 1}'s layout is not a layout`);
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
export const layoutTemplatesStore = new DataStore<LayoutTemplate[]>("layout-templates.json", [], "config", { restoreCheck });
