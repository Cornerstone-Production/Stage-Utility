// Persists named, reusable custom-layout templates (a library, global — not per
// service type or view).

import type { LayoutTemplate } from "../types/stage.js";
import { DataStore } from "./data-store.js";

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
export const layoutTemplatesStore = new DataStore<LayoutTemplate[]>("layout-templates.json", [], "config");
