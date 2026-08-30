// What a view points at, gathered in one walk.
//
// Pure and total: it reads layouts and returns data, touching no store. Export
// decides what to do with the answer; this decides only what the answer is.
// Import uses the same walk for its rebind list, so what the review screen
// promises and what import does cannot drift apart.

import type { View, LayoutObject } from "../types/views.js";
import type { ViewRefs, UnresolvableRef } from "../types/view-bundle.js";

/**
 * Walk an object tree, parent before children. Containers nest arbitrarily deep.
 *
 * Exported because the remapper needs the same traversal, and this repository
 * already carries several hand-rolled copies of it. Two more would have been
 * two more places for a container's children to get forgotten.
 */
export function walkLayoutObjects(
  objects: readonly LayoutObject[],
  visit: (o: LayoutObject) => void,
): void {
  for (const o of objects) {
    visit(o);
    if (o.children?.length) walkLayoutObjects(o.children, visit);
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function collectRefs(all: readonly View[], rootId: string): ViewRefs {
  const byId = new Map(all.map((v) => [v.id, v]));
  const embedded: string[] = [];
  const objectIds: string[] = [];
  const imageFiles: string[] = [];
  const osc: string[] = [];
  const ross: string[] = [];
  const unresolvable: UnresolvableRef[] = [];

  // Breadth-first over the embed graph. `seen` starts with the root, so a cycle
  // terminates and the root never lists itself as its own dependency.
  const seen = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length) {
    const v = byId.get(queue.shift() as string);
    if (!v?.layout) continue;
    const viewId = v.id;

    walkLayoutObjects(v.layout.objects, (o) => {
      objectIds.push(o.id);
      const c = o.config as unknown as Record<string, unknown>;
      const type = str(c.type);

      // `screen-embed` is deliberately absent from THIS expression: it
      // references an OUTPUT, not a view, and an output is per-install — its
      // routed view does not travel with an export at all (see
      // docs/moving-a-view.md). Putting its outputId here would put a
      // non-view id into a list of view ids. It is not refless, though — it
      // goes on the rebind work list below, because a bundle carries views
      // and never outputs.
      const embed =
        type === "view-embed" ? str(c.viewId)
        : type === "slots-grid" && c.source === "view" ? str(c.sourceViewId)
        : "";
      if (embed && !seen.has(embed)) {
        seen.add(embed);
        embedded.push(embed);
        queue.push(embed);
      }

      // `/layout-images/<file>` on the wire; `<dir>/<file>` in the bundle, which
      // is the shape ConfigSnapshot.images already uses.
      if (type === "image") {
        // Same shape layout-image-store matches: a query or fragment is not
        // part of the filename, and taking it as one yields a ref the reader
        // then refuses — an image that vanishes with nobody told.
        const m = /\/layout-images\/([^/?#]+)/.exec(str(c.src));
        if (m) imageFiles.push(`layout-images/${m[1]}`);
      }

      if (type === "osc-button" && str(c.targetId)) osc.push(str(c.targetId));
      if (type === "rosstalk-button" && str(c.targetId)) ross.push(str(c.targetId));

      // Hardware. Named individually because the import report is a work list,
      // not a count — the operator has to find these objects to fix them.
      const push = (kind: UnresolvableRef["kind"], value: string, label: string): void => {
        if (value) unresolvable.push({ kind, viewId, objectId: o.id, label: label || o.id, value });
      };
      if (type === "wireless-channel") push("wireless", str(c.channelId), str(c.label));
      if (type === "spl-meter") push("spl", str(c.meterId), str(c.meterId));
      if (type === "people-counter") push("sensource", str(c.zoneId), str(c.zoneId));
      if (type === "charger-battery") {
        for (const b of Array.isArray(c.bays) ? c.bays : []) {
          push("charger", str((b as Record<string, unknown>)?.id), "Charger bay");
        }
      }
      // The PRIMARY instance is "default" on every install, so only an EXTRA
      // instance is work. Same reasoning as integration-status, whose id is a
      // fixed constant and is never listed at all.
      const pp = str(c.propresenterInstanceId);
      if (pp && pp !== "default") push("propresenter", pp, "ProPresenter");
      // The screen a `screen-embed` watches. Output ids are per-install and a
      // bundle carries no outputs, so every screen tile in an imported wall
      // points at nothing until somebody repoints it. Named here so the import
      // report says which objects, rather than the operator finding out from a
      // wall of "That screen no longer exists" on a Sunday.
      //
      // No output name to borrow — a bundle carries no outputs, so there is
      // nothing here to read one from (see above). The object id at least
      // tells two rows on a producer wall apart; the literal "Screen" told
      // them apart from nothing.
      if (type === "screen-embed") push("output", str(c.outputId), o.id);
    });
  }

  const uniq = (a: string[]): string[] => [...new Set(a)];
  return {
    embeddedViewIds: embedded,
    objectIds,
    imageFiles: uniq(imageFiles),
    oscTargetIds: uniq(osc),
    rosstalkTargetIds: uniq(ross),
    unresolvable,
  };
}
