// A slots widget the layout editor saved in the shape before boards ("Define here"
// or "Embed a view") comes back from the server pointed at a board; the editor
// adopts that pointer so the widget does not keep the old shape until reopened.

import type { LayoutObject, LayoutObjectConfig } from "@main/types/stage";

/**
 * The editor's objects with each slots widget it sent in the shape before boards
 * (a "Define here" or "Embed a view" choice) taking the board pointer the saved
 * layout gave it. Without this the widget keeps reading as "save to copy" until
 * the editor is reopened. Answers `local` itself when nothing changed.
 */
export function adoptSavedGridPointers(local: LayoutObject[], saved: readonly LayoutObject[]): LayoutObject[] {
  const savedConfig = new Map<string, LayoutObjectConfig>();
  const collect = (objs: readonly LayoutObject[]): void => {
    for (const o of objs) {
      if (o.config.type === "slots-grid") savedConfig.set(o.id, o.config);
      if (o.children) collect(o.children);
    }
  };
  collect(saved);
  let changed = false;
  const adopt = (objs: LayoutObject[]): LayoutObject[] =>
    objs.map((o) => {
      let next = o;
      const fresh = savedConfig.get(o.id);
      if (o.config.type === "slots-grid" && "source" in o.config && fresh && !("source" in fresh)) {
        next = { ...next, config: fresh };
        changed = true;
      }
      if (o.children) {
        const children = adopt(o.children);
        if (children !== o.children) next = { ...next, children };
      }
      return next;
    });
  const out = adopt(local);
  return changed ? out : local;
}
