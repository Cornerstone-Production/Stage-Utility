// What a view points at, what travels with it, and what came back.
//
// A custom layout is not self-contained: its objects reference other views,
// images, targets and hardware. These types name the three outcomes — travels,
// resolves anyway, needs rebinding — so no caller has to re-derive them.

import type { View } from "./views.js";
import type { Slot, ScriptViewLayout, SlotPreset } from "./pco.js";
import type { PatchVariant } from "./patch.js";
import type { OscTargetConfig } from "./osc.js";
import type { RossTalkTargetConfig } from "./rosstalk.js";

/** A binding that names something — hardware, or a screen — the destination will
 *  not have. */
export interface UnresolvableRef {
  kind: "wireless" | "charger" | "spl" | "sensource" | "propresenter" | "output";
  /** The view whose layout holds it — without this the rebind list cannot link
   *  anywhere, since an object id alone does not say which editor to open. */
  viewId: string;
  /** The layout object holding it. */
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
  /**
   * Present only on a PLAN export — one service type's whole setup rather than
   * one layout. Absent on a view export, and every field below that a plan
   * export adds is optional for the same reason: a view export is byte for byte
   * what it always was, and an older install's importer ignores what it does
   * not know.
   */
  plan?: {
    serviceTypeId: string;
    serviceTypeName: string;
    /** "type": slot boards for this type only. "all": every type's board on the
     *  exported views. */
    slotsScope: "type" | "all";
  };
  /** Ids of the top-level views. Absent on a view export, where `views[0]` is
   *  the one root and everything after it is embedded. */
  roots?: string[];
  views: View[];
  sideData: {
    /** slots.json key -> serviceTypeId -> rows. Key is a view id or object id. */
    slots: Record<string, Record<string, Slot[]>>;
    /** layout object id -> notes content. Left loose because NotesContent lives
     *  in a service module, and this type is imported by the renderer. */
    notes: Record<string, unknown>;
    scriptviewLayouts: ScriptViewLayout[];
    /** The patch variant this service type is assigned to, per sheet that
     *  assigns one. The RIG — devices, endpoints, the default patch — is not
     *  exported: it is the building's, and a variant is an overlay of overrides
     *  on top of whatever the destination's own patch says. */
    patchVariants?: { sheetId: string; sheetName: string; variant: PatchVariant }[];
    /** Saved slot arrangements. Global rather than per type, so they travel by
     *  choice and not because the type was picked. */
    presets?: SlotPreset[];
  };
  targets: { osc: OscTargetConfig[]; rosstalk: RossTalkTargetConfig[] };
  /** `<dir>/<file>` -> base64, matching ConfigSnapshot.images. */
  images: Record<string, string>;
  /** Images the layout references that the EXPORT could not read. Carried so the
   *  import can say so — otherwise neither end ever tells a human that the
   *  layout points at a picture which did not travel. */
  missingImages?: string[];
}

export interface ImportReport {
  views: { id: string; name: string; renamedFrom?: string }[];
  targetsAdded: { kind: "osc" | "rosstalk"; id: string; name: string }[];
  targetsKept: { kind: "osc" | "rosstalk"; id: string; name: string }[];
  images: { written: number; shared: number; failed: string[] };
  /** Keys in the file that could not be used — a hostile or corrupt bundle.
   *  Dropped rather than fatal, and named rather than swallowed. */
  skipped: string[];
  /** The work list. Objects whose bindings name absent hardware. */
  rebind: UnresolvableRef[];
  /** Present only when the file was a plan export. `retypedFrom` is set when the
   *  importer landed the boards under a different service type than the file
   *  named — the id they came from, so the report can say so. */
  plan?: { serviceTypeId: string; serviceTypeName: string; retypedFrom?: string };
  /** How many (key, service type) slot boards landed, and how many rows across
   *  them. Boards never clash — see the note in view-import.ts. */
  slotBoards: number;
  slotRows: number;
  /**
   * What happened to each patch variant in the file. One entry per variant, one
   * outcome each:
   *
   *   added          not here; added to the sheet and this type assigned to it
   *   assigned       already here and left as it is; this type now points at it
   *   kept           nothing written — the sheet and its assignment are untouched
   *   replaced       overwritten with the file's copy and this type assigned to it
   *   reassigned     the type pointed at <previousVariantName>; it now uses the
   *                  file's variant, which was added or overwritten
   *   no-such-sheet  no sheet here matches by id or by name; nothing written
   *
   * "kept" and "reassigned" are the two halves of a clash: the type already has
   * a DIFFERENT variant on that sheet, and the operator chose Keep or Replace.
   * Under Keep the variant is not even added, because a variant nothing points
   * at is clutter in the patch editor rather than a useful spare. Under Replace
   * the assignment moves, and the outcome names what it moved OFF — "added"
   * alone never told the operator their assignment had been taken away.
   */
  patchVariants: (
    | {
      sheetName: string;
      variantName: string;
      outcome: "added" | "assigned" | "kept" | "replaced" | "no-such-sheet";
    }
    | {
      sheetName: string;
      variantName: string;
      outcome: "reassigned";
      /** What this service type pointed at before the import moved it. */
      previousVariantName: string;
    }
  )[];
  presets: { added: number; kept: number; replaced: number };
}
