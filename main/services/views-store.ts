// Persists View definitions (content, decoupled from physical screens).
//
// Storage shape:  View[]  in views.json
//
// Slot data for slots-kind Views is NOT stored here — it lives in slots.json
// (see slots-store.ts) keyed by the View id, so Views migrated 1:1 from the old
// per-display model reuse their existing slot storage with no rewrite.

import type { View } from "../types/stage.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<View[]>("views.json", []);

export const viewsStore = {
  async load(): Promise<View[]> {
    return store.load();
  },

  async save(views: View[]): Promise<void> {
    return store.save(views);
  },
};
