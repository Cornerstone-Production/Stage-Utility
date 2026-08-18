// Give an imported bundle ids of its own.
//
// layout-clone already mints fresh OBJECT ids and hands back the map. What it
// does not do is rewrite the references INSIDE config — it shallow-copies that
// object — which is correct when duplicating a view in place and wrong when
// several views arrive together and one embeds another. Without the rewrite the
// embed still names a view id from the SOURCE install, which at the destination
// is somebody else's view or nothing at all.

import { cloneLayoutWithMap } from "./layout-clone.js";
import { walkLayoutObjects } from "./view-refs.js";
import type { View, LayoutObject } from "../types/views.js";

/** Rewrite embed references in place, on the CLONE. */
function rewrite(objects: LayoutObject[], viewIdMap: Map<string, string>): void {
  walkLayoutObjects(objects, (o) => {
    const c = o.config as unknown as Record<string, unknown>;
    for (const key of ["viewId", "sourceViewId"] as const) {
      const cur = c[key];
      // Only what came in the bundle. A reference to a view that is not here may
      // resolve locally, and rewriting it would break a working link.
      if (typeof cur === "string" && viewIdMap.has(cur)) c[key] = viewIdMap.get(cur);
    }
  });
}

export function remapBundle(
  views: readonly View[],
  newViewId: () => string,
): { views: View[]; viewIdMap: Map<string, string>; objectIdMap: Map<string, string> } {
  const viewIdMap = new Map<string, string>();
  for (const v of views) viewIdMap.set(v.id, newViewId());

  const objectIdMap = new Map<string, string>();
  const out = views.map((v) => {
    if (!v.layout) return { ...v, id: viewIdMap.get(v.id) as string };
    // cloneLayoutWithMap deep-clones, so the rewrite below cannot reach the
    // caller's bundle — import may be retried, and a walk that edited its own
    // input would leave the second attempt working on rewritten data.
    const { layout, idMap } = cloneLayoutWithMap(v.layout);
    for (const [from, to] of idMap) objectIdMap.set(from, to);
    rewrite(layout.objects, viewIdMap);
    return { ...v, id: viewIdMap.get(v.id) as string, layout };
  });

  return { views: out, viewIdMap, objectIdMap };
}
