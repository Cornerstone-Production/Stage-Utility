// Persists named, reusable custom-layout templates (a library, global — not per
// service type or view).

import type { LayoutTemplate } from "../types/stage.js";
import { isLayoutShape } from "../types/views.js";
import { DataStore } from "./data-store.js";
import { asArray, asObject, checked, refuse, required } from "./restore-check.js";

/** POST /api/layout-templates: a name, and a layout of the shape a view's is. */
const restoreCheck = checked((raw) => {
  asArray(raw, "the layout templates").forEach((entry, i) => {
    const t = asObject(entry, `layout template ${i + 1}`);
    required(t.id, "string", `layout template ${i + 1}'s id`);
    required(t.name, "string", `layout template ${i + 1}'s name`);
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
