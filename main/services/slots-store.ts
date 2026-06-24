// Persists per-display, per-service-type slot configuration.
//
// Storage shape (v2):  Record<displayId, Record<serviceTypeId, Slot[]>>
//
// Migration from v1:  Record<serviceTypeId, Slot[]>  → placed under "display-1"
// Migration from v0:  Slot[] (flat array)             → placed under "display-1" / "default"

import type { Slot } from "../types/stage.js";
import { DataStore } from "./data-store.js";

// Outer key = displayId, inner key = serviceTypeId.
type SlotsMap = Record<string, Record<string, Slot[]>>;

const store = new DataStore<SlotsMap>("slots.json", {});

/** Normalise whatever shape is on disk into the v2 SlotsMap. */
async function loadNormalised(): Promise<SlotsMap> {
  const raw = await store.load();

  // v0: flat Slot[] at root.
  if (Array.isArray(raw)) {
    const migrated: SlotsMap = { "display-1": { default: raw as unknown as Slot[] } };
    await store.save(migrated);
    console.log("[slots-store] migrated v0 (flat array) → display-1/default");
    return migrated;
  }

  // v1: Record<serviceTypeId, Slot[]> — values are arrays, not objects.
  // Detect: at least one value is an array directly.
  const values = Object.values(raw);
  if (values.length > 0 && Array.isArray(values[0])) {
    const migrated: SlotsMap = { "display-1": raw as unknown as Record<string, Slot[]> };
    await store.save(migrated);
    console.log("[slots-store] migrated v1 (serviceType map) → display-1");
    return migrated;
  }

  // v2: already correct shape.
  return raw as SlotsMap;
}

export const slotsStore = {
  async getSlots(displayId: string, serviceTypeId: string): Promise<Slot[]> {
    const map = await loadNormalised();
    return map[displayId]?.[serviceTypeId] ?? [];
  },

  async setSlots(displayId: string, serviceTypeId: string, slots: Slot[]): Promise<void> {
    const map = await loadNormalised();
    if (!map[displayId]) map[displayId] = {};
    map[displayId][serviceTypeId] = slots;
    await store.save(map);
  },

  // One-time recovery for display-1: if the active service type has no slots but
  // the legacy "default" bucket has some, adopt them and clear the bucket.
  async adoptDefaultInto(displayId: string, serviceTypeId: string): Promise<Slot[]> {
    const map = await loadNormalised();
    const displayMap = map[displayId] ?? {};
    const existing = displayMap[serviceTypeId] ?? [];
    const fallback = displayMap["default"] ?? [];
    if (existing.length === 0 && fallback.length > 0) {
      displayMap[serviceTypeId] = fallback;
      delete displayMap["default"];
      map[displayId] = displayMap;
      await store.save(map);
      console.log(`[slots-store] adoptDefaultInto display=${displayId} serviceType=${serviceTypeId} (${fallback.length} slots)`);
      return fallback;
    }
    return existing;
  },

  // Copy an entire key's per-service-type slot config to a new key, minting fresh
  // slot ids in each set (used when a custom layout / View with inline mic-slots is
  // duplicated). No-op if the source key has nothing.
  async copyKey(srcKey: string, destKey: string, freshId: () => string): Promise<void> {
    const map = await loadNormalised();
    const src = map[srcKey];
    if (!src) return;
    const copy: Record<string, Slot[]> = {};
    for (const [serviceTypeId, slots] of Object.entries(src)) {
      copy[serviceTypeId] = slots.map((s) => ({ ...s, id: freshId() }));
    }
    map[destKey] = copy;
    await store.save(map);
    console.log(`[slots-store] copyKey ${srcKey} → ${destKey}`);
  },

  async removeDisplay(displayId: string): Promise<void> {
    const map = await loadNormalised();
    if (displayId in map) {
      delete map[displayId];
      await store.save(map);
      console.log(`[slots-store] removeDisplay ${displayId}`);
    }
  },
};
