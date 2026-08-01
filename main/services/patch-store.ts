// patch-store.ts — Persists the stage patch sheets. Each sheet (Analog, Dante,
// WSG, Monitoring, …) carries its own devices, default endpoint patch, variants,
// and weekly assignments. Backed by the generic DataStore (patch.json). See
// docs/patch-sheet/DESIGN.md.

import type { PatchFile, PatchSheet, PatchSheetKind } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const emptyAssignments = () => ({ byServiceType: {}, byPlan: {} });
function blankSheet(id: string, name: string, kind: PatchSheetKind): PatchSheet {
  return { id, name, kind, devices: [], endpoints: [], variants: [], assignments: emptyAssignments() };
}

// A fresh install ships with the four common patch surfaces; all are renamable /
// removable in the editor.
const seedSheets = (): PatchSheet[] => [
  blankSheet("analog", "Analog", "analog"),
  blankSheet("dante", "Dante", "dante"),
  blankSheet("wsg", "WSG", "network"),
  blankSheet("monitoring", "Monitoring", "monitor"),
];

const EMPTY: PatchFile = { sheets: seedSheets(), updatedAt: "" };

/**
 * Normalize any stored shape into the current multi-sheet PatchFile:
 *  - New shape (`{ sheets }`) → returned as-is.
 *  - Legacy single-patch (`{ devices, endpoints, variants, assignments }`) → its
 *    data becomes the "Analog" sheet, plus the other three seeded — so existing
 *    patches survive the upgrade untouched.
 * DataStore.load() returns the parsed file as-is (no merge), so no data is lost.
 */
function migrate(raw: PatchFile): PatchFile {
  const r = raw as unknown as Record<string, unknown> | null;
  if (r && Array.isArray(r.sheets)) return raw;
  const legacy = (r ?? {}) as Partial<PatchSheet> & { updatedAt?: string };
  const analog: PatchSheet = {
    ...blankSheet("analog", "Analog", "analog"),
    devices: legacy.devices ?? [],
    endpoints: legacy.endpoints ?? [],
    variants: legacy.variants ?? [],
    assignments: legacy.assignments ?? emptyAssignments(),
  };
  return {
    sheets: [analog, blankSheet("dante", "Dante", "dante"), blankSheet("wsg", "WSG", "network"), blankSheet("monitoring", "Monitoring", "monitor")],
    updatedAt: legacy.updatedAt ?? "",
  };
}

class PatchStore {
  private store = new DataStore<PatchFile>("patch.json", EMPTY);

  /** The full patch file (all sheets), migrated to the current shape. */
  async load(): Promise<PatchFile> {
    return migrate(await this.store.load());
  }

  /** Replace the whole patch file, stamping updatedAt. Returns the saved file. */
  async save(file: PatchFile): Promise<PatchFile> {
    const next: PatchFile = { ...file, updatedAt: new Date().toISOString() };
    await this.store.update(() => next);
    return next;
  }
}

export const patchStore = new PatchStore();
