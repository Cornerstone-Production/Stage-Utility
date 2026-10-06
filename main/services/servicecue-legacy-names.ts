// servicecue-legacy-names.ts — what ServiceCue was called when an older build saved it.
//
// The feature was named ScriptView until it was renamed. Anything an older build
// wrote — a views.json, a view export, a config backup — says ScriptView, and
// stays readable here rather than being rejected or, worse, silently ignored.
// Everything in this file READS the old names; nothing writes them. The file
// names a store used to have are declared on the stores themselves
// (DataStore's `renamedFrom`).

import type { ServiceCueLayout } from "../types/pco.js";
import type { View } from "../types/views.js";

/** The log tag the migrations speak under. */
export const SERVICECUE_LOG_TAG = "servicecue";

/** The field a View used to carry for its column preset. */
const LEGACY_LAYOUT_FIELD = "scriptViewLayoutId";

/**
 * Views as today's build reads them: a view an older build saved carries its
 * column preset as `scriptViewLayoutId`, and comes back carrying
 * `serviceCueLayoutId`. The next save writes the new field; nothing is written
 * here.
 *
 * Total, because it runs on whatever a file held: anything that is not an array
 * of objects passes through unchanged. A view that already has the new field
 * keeps it, and the old one is dropped; a list with nothing to migrate comes
 * back as the same array, so callers that compare by reference see no change.
 */
export function adoptLegacyViewFields<V>(views: V): V {
  if (!Array.isArray(views)) return views;
  if (!views.some((v) => v !== null && typeof v === "object" && Object.hasOwn(v, LEGACY_LAYOUT_FIELD))) return views;
  return views.map((v) => {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, LEGACY_LAYOUT_FIELD)) return v;
    const { [LEGACY_LAYOUT_FIELD]: legacy, ...rest } = v as Record<string, unknown>;
    const current = (rest as Partial<View>).serviceCueLayoutId;
    return current === undefined ? { ...rest, serviceCueLayoutId: legacy } : rest;
  }) as V;
}

/**
 * The column presets a view bundle carries: `serviceCueLayouts`, or the key an
 * export from before the rename used. The new key wins when both are present.
 */
export function bundledServiceCueLayouts(sideData: unknown): ServiceCueLayout[] {
  const side = (sideData ?? {}) as { serviceCueLayouts?: unknown; scriptviewLayouts?: unknown };
  if (Array.isArray(side.serviceCueLayouts)) return side.serviceCueLayouts as ServiceCueLayout[];
  if (Array.isArray(side.scriptviewLayouts)) return side.scriptviewLayouts as ServiceCueLayout[];
  return [];
}
