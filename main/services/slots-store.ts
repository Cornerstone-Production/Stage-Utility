// Persists per-display, per-service-type slot configuration.
//
// Storage shape (v2):  Record<displayId, Record<serviceTypeId, Slot[]>>
//
// Migration from v1:  Record<serviceTypeId, Slot[]>  → placed under "display-1"
// Migration from v0:  Slot[] (flat array)             → placed under "display-1" / "default"

import type { Slot, SlotLink } from "../types/stage.js";
import { scrub } from "./scrub.js";
import { DataStore } from "./data-store.js";
import { assertSafeKey } from "./safe-key.js";

/** v2 -> v3: a single `teamPositionName` + `notesStartsWith` becomes a `positions`
 *  range. Exported for tests. Total by design — DataStore does not deep-merge on
 *  load, so anything on disk must come back as a valid SlotLink. */
export function migrateSlotLink(link: unknown): SlotLink {
  const l = link as Record<string, unknown> | null;
  if (!l || typeof l !== "object") return { kind: "pco", matchBy: "position", positions: [] };

  if (l.kind === "static" || l.kind === "empty" || l.kind === "spacer") return l as unknown as SlotLink;
  if (l.kind === "pco" && l.matchBy === "person") return l as unknown as SlotLink;

  if (l.kind === "pco" && l.matchBy === "position") {
    if (Array.isArray(l.positions)) return l as unknown as SlotLink; // already v3
    const name = typeof l.teamPositionName === "string" ? l.teamPositionName.trim() : "";
    const note = typeof l.notesStartsWith === "string" ? l.notesStartsWith.trim() : "";
    if (!name) return { kind: "pco", matchBy: "position", positions: [] };
    return {
      kind: "pco",
      matchBy: "position",
      positions: [note ? { name, notesStartsWith: note } : { name }],
    };
  }

  return { kind: "pco", matchBy: "position", positions: [] };
}

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

  // v3: rewrite every slot's link into the positions-range shape. Cheap and
  // idempotent, so it runs on every load rather than needing a version stamp.
  const map = raw as SlotsMap;
  let changed = false;
  for (const byType of Object.values(map)) {
    for (const slots of Object.values(byType)) {
      for (const slot of slots as Slot[]) {
        const next = migrateSlotLink(slot.link);
        if (JSON.stringify(next) !== JSON.stringify(slot.link)) {
          slot.link = next;
          changed = true;
        }
      }
    }
  }
  if (changed) {
    await store.save(map);
    console.log("[slots-store] migrated v2 links -> v3 position ranges");
  }
  return map;
}

export const slotsStore = {
  async getSlots(displayId: string, serviceTypeId: string): Promise<Slot[]> {
    const map = await loadNormalised();
    return map[displayId]?.[serviceTypeId] ?? [];
  },

  async setSlots(displayId: string, serviceTypeId: string, slots: Slot[]): Promise<void> {
    // Both keys arrive from a request. `map["__proto__"]` is truthy, so the
    // guard below would pass and the write would land on Object.prototype.
    assertSafeKey(displayId, "displayId");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    const map = await loadNormalised();
    if (!map[displayId]) map[displayId] = {};
    map[displayId][serviceTypeId] = slots;
    await store.save(map);
  },

  // One-time recovery for display-1: if the active service type has no slots but
  // the legacy "default" bucket has some, adopt them and clear the bucket.
  async adoptDefaultInto(displayId: string, serviceTypeId: string): Promise<Slot[]> {
    assertSafeKey(displayId, "displayId");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    const map = await loadNormalised();
    const displayMap = map[displayId] ?? {};
    const existing = displayMap[serviceTypeId] ?? [];
    const fallback = displayMap["default"] ?? [];
    if (existing.length === 0 && fallback.length > 0) {
      displayMap[serviceTypeId] = fallback;
      delete displayMap["default"];
      map[displayId] = displayMap;
      await store.save(map);
      console.log(`[slots-store] adoptDefaultInto display=${scrub(displayId)} serviceType=${scrub(serviceTypeId)} (${fallback.length} slots)`);
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
