// patch.ts — Stage patch sheet.
//
// See docs/patch-sheet/DESIGN.md.
//
// Split out of stage.ts, which had grown to 1,509 lines. Every name is still
// re-exported from stage.ts, so no import anywhere had to change.


// ── Stage patch sheet (see docs/patch-sheet/DESIGN.md) ───────────────────────
export type PatchDeviceKind = "rack" | "snake" | "drop-snake" | "pocket" | "wireless" | "array" | "other";

/** A physical device that carries channels (SD rack, snake, pocket, RF bank, …). */
export interface PatchDevice {
  id: string;
  name: string;
  kind: PatchDeviceKind;
  inputs: number;
  outputs: number;
  /** Optional custom connector labels; default = "1".."N" (supports "B-1", "S11", …). */
  inLabels?: string[];
  outLabels?: string[];
  /** Optional color ("#rrggbb") to tint every channel sourced from this device. */
  color?: string;
}

/** One hop in a signal path: a specific connector on a device. */
export interface PatchHop {
  deviceId: string;
  connector: string;
}

/** One console endpoint on a rack — the spine of the patch. */
export interface PatchEndpoint {
  rackId: string;
  dir: "in" | "out";
  index: number;
  consoleChannel?: string;
  /** Source (in) / destination (out) name. */
  label?: string;
  /** Input metadata. */
  mic?: string;
  phantom?: boolean;
  /** Output metadata: "IEM" | "wedge" | "amp" | "stream" | "record" | … */
  feedType?: string;
  /** Ordered upstream (in) / downstream (out) hops; empty/absent = direct. */
  path?: PatchHop[];
  unused?: boolean;
  notes?: string;
  /** Optional ownership/section tag (e.g. "338 @ FOH") — groups channels under a
   *  subheading, mirroring the ownership bands on a Dante patch sheet. */
  owner?: string;
  /** HOOK: link a vocal/RF endpoint to a mic-board channel (feature later). */
  micSlotRef?: string | null;
  /** HOOK: PCO team position tag for scheduling suggestions (feature later). */
  pcoPosition?: string | null;
}

/** A named overlay of endpoint overrides on the default patch (template == event). */
export interface PatchVariant {
  id: string;
  name: string;
  /** key = `${rackId}:${dir}:${index}`; value = only the changed fields. */
  overrides: Record<string, Partial<PatchEndpoint>>;
}

export interface PatchAssignments {
  /** Standing variant per PCO service type. */
  byServiceType: Record<string, string>;
  /** Per specific PCO plan: override variant + one-off week tweaks. */
  byPlan: Record<string, { variantId?: string; tweaks?: Record<string, Partial<PatchEndpoint>> }>;
}

/** What kind of patch a sheet documents — drives labels/cosmetics only. */
export type PatchSheetKind = "analog" | "dante" | "network" | "monitor" | "custom";

/** One patch surface (a tab): its own devices, default endpoints, variants, and
 *  weekly assignments. Analog stage patch, Dante, Waves SoundGrid, monitors, etc.
 *  each are a sheet of this same shape. */
export interface PatchSheet {
  id: string;
  name: string;
  kind: PatchSheetKind;
  devices: PatchDevice[];
  /** The DEFAULT patch for this sheet (source of truth). */
  endpoints: PatchEndpoint[];
  variants: PatchVariant[];
  assignments: PatchAssignments;
}

export interface PatchFile {
  /** All patch sheets (tabs). At least one; the first is the default view. */
  sheets: PatchSheet[];
  updatedAt: string;
}
