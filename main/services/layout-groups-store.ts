// Persists named, reusable layout "groups" — a single object (typically a
// container + its children) that can be inserted into any custom View. Global,
// like layout templates (not per service type or view).

import type { LayoutGroup } from "../types/stage.js";
import { DataStore } from "./data-store.js";
import { asArray, asObject, checked, required } from "./restore-check.js";

/** POST /api/layout-groups: a name, and an object. */
const restoreCheck = checked((raw) => {
  asArray(raw, "the layout groups").forEach((entry, i) => {
    const g = asObject(entry, `layout group ${i + 1}`);
    required(g.id, "string", `layout group ${i + 1}'s id`);
    required(g.name, "string", `layout group ${i + 1}'s name`);
    asObject(g.object, `layout group ${i + 1}'s object`);
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
export const layoutGroupsStore = new DataStore<LayoutGroup[]>("layout-groups.json", [], "config", { restoreCheck });
