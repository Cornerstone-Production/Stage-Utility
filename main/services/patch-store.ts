// patch-store.ts — Persists the stage patch sheet: devices, the default endpoint
// patch, named variants, and weekly assignments. Backed by the generic DataStore
// (patch.json). See docs/patch-sheet/DESIGN.md.

import type { PatchFile } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const EMPTY: PatchFile = {
  devices: [],
  endpoints: [],
  variants: [],
  assignments: { byServiceType: {}, byPlan: {} },
  updatedAt: "",
};

class PatchStore {
  private store = new DataStore<PatchFile>("patch.json", EMPTY);

  /** The full patch file (devices + default endpoints + variants + assignments). */
  async load(): Promise<PatchFile> {
    return this.store.load();
  }

  /** Replace the whole patch file, stamping updatedAt. Returns the saved file. */
  async save(file: PatchFile): Promise<PatchFile> {
    const next: PatchFile = { ...file, updatedAt: new Date().toISOString() };
    await this.store.update(() => next);
    return next;
  }
}

export const patchStore = new PatchStore();
