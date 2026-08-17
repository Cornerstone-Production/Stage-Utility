// What a view points at, what travels with it, and what came back.
//
// A custom layout is not self-contained: its objects reference other views,
// images, targets and hardware. These types name the three outcomes — travels,
// resolves anyway, needs rebinding — so no caller has to re-derive them.

import type { View } from "./views.js";

/** A binding that names hardware the destination will not have. */
export interface UnresolvableRef {
  kind: "wireless" | "charger" | "spl" | "sensource" | "propresenter";
  /** The layout object holding it, so the UI can select it in the editor. */
  objectId: string;
  /** What to call it in the rebind list, e.g. "Handheld 3". */
  label: string;
  /** The id it points at, shown so an operator can recognise it. */
  value: string;
}

export interface ViewRefs {
  /** Views this one embeds, transitively. Excludes the root. */
  embeddedViewIds: string[];
  /** Every layout object id across every collected view. */
  objectIds: string[];
  /** `layout-images/<file>` paths referenced by image objects. */
  imageFiles: string[];
  oscTargetIds: string[];
  rosstalkTargetIds: string[];
  /** Device-level bindings, for the rebind work list. */
  unresolvable: UnresolvableRef[];
}

export interface ViewBundle {
  kind: "stage-utility-view";
  version: 1;
  appVersion: string;
  createdAt: string;
  source: { server: string };
  views: View[];
  sideData: {
    /** slots.json key -> serviceTypeId -> rows. Key is a view id or object id. */
    slots: Record<string, Record<string, unknown[]>>;
    /** layout object id -> notes content. */
    notes: Record<string, unknown>;
    scriptviewLayouts: unknown[];
  };
  targets: { osc: unknown[]; rosstalk: unknown[] };
  /** `<dir>/<file>` -> base64, matching ConfigSnapshot.images. */
  images: Record<string, string>;
}

export interface ImportReport {
  views: { id: string; name: string; renamedFrom?: string }[];
  targetsAdded: { kind: "osc" | "rosstalk"; id: string; name: string }[];
  targetsKept: { kind: "osc" | "rosstalk"; id: string; name: string }[];
  images: { written: number; shared: number; failed: string[] };
  /** The work list. Objects whose bindings name absent hardware. */
  rebind: UnresolvableRef[];
}
