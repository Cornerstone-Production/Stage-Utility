// Persists ScriptView-wide config — currently which service types appear on the
// landing page (curated per church, since service types differ between orgs).

import type { ScriptViewConfig } from "../types/stage.js";
import { DataStore } from "./data-store.js";

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
export const scriptViewConfigStore = new DataStore<ScriptViewConfig>("scriptview-config.json", { serviceTypeIds: [] }, "config");
