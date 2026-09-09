// Persists per-display (or per inline slots-grid object) slot configuration.
//
// Two halves, and the difference between them is the whole point of this file:
//
//   defaults   the board a service type comes back to, per key, per service type
//   overrides  a board saved for ONE Planning Center plan, used only while that
//              plan is the current one
//
// A swap made for one week used to be stored per service type, so it silently
// became every following week's board. An override expires by itself: the next
// plan of that type falls back to the default.
//
// Storage shape on disk (v3):
//   { version: 3,
//     defaults:  Record<key, Record<serviceTypeId, Slot[]>>,
//     overrides: Record<key, Record<planId, { serviceTypeId, sortDate, slots }>> }
//
// IN MEMORY those two halves are nested Maps, not records. The keys are request
// derived — a view id, a layout object id, a service type id, a plan id — and
// `obj[key] = value` with a key from a request is a property write onto an
// object somebody else chooses the name of. `Map.prototype.set` is not a
// property write at all, so the whole class of prototype-pollution question
// stops being asked. normaliseSlotsFile() builds the Maps on load and
// serialiseSlotsFile() turns them back into the records above on every write:
// the bytes on disk are unchanged.
//
// Migration from v2:  Record<key, Record<serviceTypeId, Slot[]>>  → `defaults`
// Migration from v1:  Record<serviceTypeId, Slot[]>               → defaults["display-1"]
// Migration from v0:  Slot[] (flat array)                         → defaults["display-1"]["default"]
//
// `version: 3` numbers the FILE ENVELOPE. It is unrelated to the "v2 -> v3 slot
// link" migration below, which renames a field inside an individual slot and has
// never had a version stamp of its own. Two independent lineages, same digit.

import type { Slot, SlotLink } from "../types/stage.js";
import { scrub } from "./scrub.js";
import { DataStore } from "./data-store.js";
import { assertSafeKey, isSafeKey } from "./safe-key.js";

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

/** SERIALISED defaults — the on-disk and API shape. Outer key = view id or
 *  layout object id, inner key = serviceTypeId. */
export type SlotsDefaults = Record<string, Record<string, Slot[]>>;

/** One plan's board. `sortDate` is the plan's PCO `sort_date`, recorded at save
 *  time so pruning can tell a stale override from a current one without asking
 *  PCO. Null when the writer did not know it. */
export interface SlotsOverride {
  serviceTypeId: string;
  sortDate: string | null;
  slots: Slot[];
}

/** SERIALISED overrides — the on-disk and API shape. Outer key = view id or
 *  layout object id, inner key = planId. */
export type SlotsOverrides = Record<string, Record<string, SlotsOverride>>;

/** The file as this module holds it: same two halves, as Maps. */
export interface SlotsFile {
  version: 3;
  /** key -> serviceTypeId -> slots */
  defaults: Map<string, Map<string, Slot[]>>;
  /** key -> planId -> override */
  overrides: Map<string, Map<string, SlotsOverride>>;
}

/** The v3 envelope as it is written to disk. */
export interface SerialisedSlotsFile {
  version: 3;
  defaults: SlotsDefaults;
  overrides: SlotsOverrides;
}

/** Which half of the file a write lands in. */
export type SlotsTarget =
  | { kind: "default"; serviceTypeId: string }
  | { kind: "plan"; planId: string; serviceTypeId: string; sortDate?: string | null };

/** `default:<serviceTypeId>` / `plan:<planId>` — for a log line and a toast. */
export function describeSlotsTarget(target: SlotsTarget): string {
  return target.kind === "default" ? `default:${target.serviceTypeId}` : `plan:${target.planId}`;
}

// The file has held four shapes over its life, so what comes back off disk is
// `unknown` and normalise() is the only thing that decides which one it is.
const store = new DataStore<unknown>("slots.json", {}, "config");

function emptyFile(): SlotsFile {
  return { version: 3, defaults: new Map(), overrides: new Map() };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Turn the in-memory Maps back into the v3 record envelope written to disk.
 *
 * `Object.fromEntries` DEFINES each own property rather than assigning it, so
 * even a key that survived from a hand-edited file cannot reach the prototype
 * chain on the way out.
 */
export function serialiseSlotsFile(file: SlotsFile): SerialisedSlotsFile {
  const defaults: SlotsDefaults = Object.fromEntries(
    [...file.defaults].map(([key, byType]) => [key, Object.fromEntries(byType)]),
  );
  const overrides: SlotsOverrides = Object.fromEntries(
    [...file.overrides].map(([key, byPlan]) => [key, Object.fromEntries(byPlan)]),
  );
  return { version: 3, defaults, overrides };
}

/** Rewrite every slot's link into the positions-range shape. Cheap and
 *  idempotent, so it runs on every load rather than needing a version stamp. */
function migrateLinks(sets: Slot[][]): boolean {
  let changed = false;
  for (const slots of sets) {
    if (!Array.isArray(slots)) continue;
    for (const slot of slots) {
      const next = migrateSlotLink(slot?.link);
      if (JSON.stringify(next) !== JSON.stringify(slot?.link)) {
        slot.link = next;
        changed = true;
      }
    }
  }
  return changed;
}

/** One half of a record envelope as a nested Map. Inner values that are not
 *  objects are dropped: nothing but a `serviceTypeId -> Slot[]` (or
 *  `planId -> override`) map is a readable inner half, and carrying junk
 *  forward only re-persists it. */
function toNestedMap<V>(half: unknown): Map<string, Map<string, V>> {
  const out = new Map<string, Map<string, V>>();
  if (!isRecord(half)) return out;
  for (const [key, inner] of Object.entries(half)) {
    if (!isRecord(inner)) {
      console.warn(`[slots-store] ${scrub(key)}: not a board map, dropped (${typeof inner})`);
      continue;
    }
    out.set(key, new Map(Object.entries(inner) as [string, V][]));
  }
  return out;
}

/** Every Slot[] in the file, for the link migration to walk. */
function allSlotSets(file: SlotsFile): Slot[][] {
  const sets: Slot[][] = [];
  for (const byType of file.defaults.values()) sets.push(...byType.values());
  for (const byPlan of file.overrides.values()) for (const o of byPlan.values()) sets.push(o?.slots);
  return sets;
}

/**
 * Decide which shape `raw` is and return it as a v3 file.
 *
 * PURE — it never writes. loadNormalised() persists the result when it changed;
 * the read-modify-write paths call this INSIDE `store.update`, where enqueuing a
 * save would deadlock against the update already holding the queue.
 *
 * The returned object is always freshly allocated at the top level, so
 * `store.update` never mistakes a mutated result for "nothing changed".
 */
export function normaliseSlotsFile(raw: unknown): { file: SlotsFile; migrated: string | null } {
  // v0: flat Slot[] at root.
  if (Array.isArray(raw)) {
    const slots = raw as Slot[];
    const file: SlotsFile = {
      version: 3,
      defaults: new Map([["display-1", new Map([["default", slots]])]]),
      overrides: new Map(),
    };
    migrateLinks([slots]);
    return { file, migrated: "v0 (flat array) → defaults/display-1/default" };
  }

  if (!isRecord(raw)) return { file: emptyFile(), migrated: null };

  // v3: already the envelope. Halves are rebuilt into Maps rather than trusted,
  // so a hand-edited file with a `defaults` that is not an object cannot poison
  // a write.
  //
  // A record carrying BOTH halves is v3 whatever the stamp says. The stamp is
  // one integer somebody hand-editing the file (or a truncated write) can lose,
  // and without this the file falls through to the v2 branch, which would re-key
  // the whole envelope under `defaults.defaults` — every wall blank, and then
  // persisted in that shape. No view or layout-object key is called "defaults"
  // AND "overrides" at the same time, so the pair is a safe signature.
  if (raw.version === 3 || (isRecord(raw.defaults) && isRecord(raw.overrides))) {
    const file: SlotsFile = {
      version: 3,
      defaults: toNestedMap<Slot[]>(raw.defaults),
      overrides: toNestedMap<SlotsOverride>(raw.overrides),
    };
    const linksChanged = migrateLinks(allSlotSets(file));
    // A restamp is worth persisting and worth a line: it means the file on disk
    // had lost its version, and the next reader would otherwise have to work the
    // shape out again.
    if (raw.version !== 3) return { file, migrated: "v3 envelope with no version stamp → restamped" };
    return { file, migrated: linksChanged ? "v2 links -> v3 position ranges" : null };
  }

  // v1: Record<serviceTypeId, Slot[]> — at least one value is an array directly.
  const values = Object.values(raw);
  if (values.length > 0 && Array.isArray(values[0])) {
    const byType = new Map(Object.entries(raw) as [string, Slot[]][]);
    const file: SlotsFile = {
      version: 3,
      defaults: new Map([["display-1", byType]]),
      overrides: new Map(),
    };
    migrateLinks([...byType.values()]);
    return { file, migrated: "v1 (serviceType map) → defaults/display-1" };
  }

  // v2: Record<key, Record<serviceTypeId, Slot[]>>. Becomes the DEFAULTS, board
  // for board, with no overrides — the day this lands, nothing on any screen
  // changes.
  const file: SlotsFile = { version: 3, defaults: toNestedMap<Slot[]>(raw), overrides: new Map() };
  const linksChanged = migrateLinks(allSlotSets(file));
  // An empty file is not a migration — a first run must not write and log.
  if (values.length === 0) return { file, migrated: null };
  return { file, migrated: linksChanged ? "v2 → v3 (defaults + links)" : "v2 → v3 (defaults)" };
}

/** Normalise whatever shape is on disk into a v3 file, persisting a migration. */
async function loadNormalised(): Promise<SlotsFile> {
  const { file, migrated } = normaliseSlotsFile(await store.load());
  if (migrated) {
    await store.save(serialiseSlotsFile(file));
    console.log(`[slots-store] migrated ${migrated}`);
  }
  return file;
}

/** Read-modify-write against the normalised file, serialised by the store's
 *  queue. Return `null` from `mutate` for "nothing to do" and no write happens. */
async function mutate(fn: (file: SlotsFile) => SlotsFile | null): Promise<void> {
  await store.update((current) => {
    const { file } = normaliseSlotsFile(current);
    const next = fn(file);
    return next ? serialiseSlotsFile(next) : current;
  });
}

export const slotsStore = {
  /**
   * Every key's DEFAULTS, for every service type — what view-export carries.
   *
   * Overrides deliberately do NOT travel in a bundle: an override is one plan's
   * exception, and the plan ids it is keyed by mean nothing on the far end. The
   * bundle format is unchanged for that reason.
   */
  async allDefaults(): Promise<SlotsDefaults> {
    return serialiseSlotsFile(await loadNormalised()).defaults;
  },

  /** Every key's overrides — for pruning and for diagnostics. */
  async allOverrides(): Promise<SlotsOverrides> {
    return serialiseSlotsFile(await loadNormalised()).overrides;
  },

  async getDefault(key: string, serviceTypeId: string): Promise<Slot[]> {
    // A read, but still request-reachable, and the caller of a rejected key is
    // confused about something: this signature says it returns Slot[].
    assertSafeKey(key, "key");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    const file = await loadNormalised();
    return file.defaults.get(key)?.get(serviceTypeId) ?? [];
  },

  async setDefault(key: string, serviceTypeId: string, slots: Slot[]): Promise<void> {
    // Both keys arrive from a request. Rejected rather than sanitised: no
    // legitimate view or service type is called "__proto__".
    assertSafeKey(key, "key");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    await mutate((file) => {
      let byType = file.defaults.get(key);
      if (!byType) {
        byType = new Map();
        file.defaults.set(key, byType);
      }
      byType.set(serviceTypeId, slots);
      return file;
    });
  },

  /**
   * One plan's board, or null.
   *
   * Both keys are asserted on the READ as well as the write. A caller that got
   * here with "__proto__" is confused, and the callers that branch on "is there
   * an override?" (clearOverride, promoteOverride, getSlotTargets) would read a
   * junk answer as yes.
   */
  async getOverride(key: string, planId: string): Promise<SlotsOverride | null> {
    assertSafeKey(key, "key");
    assertSafeKey(planId, "planId");
    const file = await loadNormalised();
    return file.overrides.get(key)?.get(planId) ?? null;
  },

  async setOverride(
    key: string,
    planId: string,
    serviceTypeId: string,
    slots: Slot[],
    sortDate: string | null = null,
  ): Promise<void> {
    assertSafeKey(key, "key");
    assertSafeKey(planId, "planId");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    await mutate((file) => {
      let byPlan = file.overrides.get(key);
      if (!byPlan) {
        byPlan = new Map();
        file.overrides.set(key, byPlan);
      }
      byPlan.set(planId, { serviceTypeId, sortDate, slots });
      return file;
    });
  },

  /** Drop one plan's override. Resolves TRUE when there was one to drop, so the
   *  caller can tell "reverted" from "there was nothing to revert". */
  async clearOverride(key: string, planId: string): Promise<boolean> {
    // Asserted here as well as inside getOverride: this is a DELETE reachable
    // from the LAN, and it reported true for `__proto__` with the file untouched.
    assertSafeKey(key, "key");
    assertSafeKey(planId, "planId");
    const existing = await this.getOverride(key, planId);
    if (!existing) return false;
    await mutate((file) => {
      const byPlan = file.overrides.get(key);
      if (!byPlan?.has(planId)) return null;
      byPlan.delete(planId);
      if (byPlan.size === 0) file.overrides.delete(key);
      return file;
    });
    return true;
  },

  /**
   * Make a plan's override the service type's default, then drop the override
   * ("Set as default").
   *
   * The service type comes from the override record, not from the caller: the
   * override knows which type its plan belongs to, and taking it from a request
   * is how a promote could land on the wrong type's board.
   */
  async promoteOverride(key: string, planId: string): Promise<SlotsOverride | null> {
    // Before the read, not after it: an unsafe planId used to reach the delete
    // below on Object.prototype and throw a TypeError, which the route turned
    // into a 404.
    assertSafeKey(key, "key");
    assertSafeKey(planId, "planId");
    const existing = await this.getOverride(key, planId);
    if (!existing) return null;
    assertSafeKey(existing.serviceTypeId, "serviceTypeId");
    await mutate((file) => {
      const byPlan = file.overrides.get(key);
      const override = byPlan?.get(planId);
      if (!byPlan || !override) return null;
      let byType = file.defaults.get(key);
      if (!byType) {
        byType = new Map();
        file.defaults.set(key, byType);
      }
      byType.set(override.serviceTypeId, override.slots);
      byPlan.delete(planId);
      if (byPlan.size === 0) file.overrides.delete(key);
      return file;
    });
    return existing;
  },

  /**
   * The one resolution rule, used everywhere raw slots are loaded: this plan's
   * override if it has one, else the service type's default, else nothing.
   *
   * An override is only honoured for the service type it was saved against — a
   * plan id belongs to a type, and a mismatch means the caller and the file
   * disagree about which, which is not something to guess through.
   */
  async resolve(key: string, serviceTypeId: string | null, planId: string | null): Promise<Slot[]> {
    if (!serviceTypeId) return [];
    // Skipped rather than thrown, unlike every write above: this is the read
    // every screen's rows come through, and an unsafe key reaching it means some
    // caller is confused, not that the wall should go blank.
    if (!isSafeKey(key) || !isSafeKey(serviceTypeId)) return [];
    const file = await loadNormalised();
    if (planId && isSafeKey(planId)) {
      const override = file.overrides.get(key)?.get(planId);
      if (override && override.serviceTypeId === serviceTypeId) return override.slots;
    }
    return file.defaults.get(key)?.get(serviceTypeId) ?? [];
  },

  /**
   * Delete every override `isExpired` says is stale. Resolves with how many went.
   *
   * The caller owns the policy — it is the only thing that can ask PCO when a
   * plan happened — and is expected to answer FALSE whenever it does not know,
   * so an unreachable PCO prunes nothing rather than guessing.
   */
  async pruneOverrides(
    isExpired: (planId: string, serviceTypeId: string, sortDate: string | null) => boolean,
  ): Promise<number> {
    let pruned = 0;
    await mutate((file) => {
      for (const byPlan of file.overrides.values()) {
        for (const [planId, override] of byPlan) {
          if (!isExpired(planId, override.serviceTypeId, override.sortDate ?? null)) continue;
          byPlan.delete(planId);
          pruned++;
        }
      }
      // Only once something actually went: mutating the file (even to drop an
      // already-empty map) and then returning null would leave the store's cache
      // disagreeing with the disk.
      if (pruned === 0) return null;
      for (const [key, byPlan] of file.overrides) {
        if (byPlan.size === 0) file.overrides.delete(key);
      }
      return file;
    });
    return pruned;
  },

  // One-time recovery for display-1: if the active service type has no default
  // slots but the legacy "default" bucket has some, adopt them and clear the
  // bucket. Returns the RESOLVED rows, so a plan override still wins.
  async adoptDefaultInto(key: string, serviceTypeId: string, planId: string | null): Promise<Slot[]> {
    assertSafeKey(key, "key");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    let adopted = 0;
    await mutate((file) => {
      const byType = file.defaults.get(key) ?? new Map<string, Slot[]>();
      const existing = byType.get(serviceTypeId) ?? [];
      const fallback = byType.get("default") ?? [];
      if (existing.length > 0 || fallback.length === 0) return null;
      byType.set(serviceTypeId, fallback);
      byType.delete("default");
      file.defaults.set(key, byType);
      adopted = fallback.length;
      return file;
    });
    if (adopted > 0) {
      console.log(
        `[slots-store] adoptDefaultInto key=${scrub(key)} serviceType=${scrub(serviceTypeId)} (${adopted} slots)`,
      );
    }
    return this.resolve(key, serviceTypeId, planId);
  },

  /**
   * Copy an entire key's slot config to a new key, minting fresh slot ids (used
   * when a custom layout / View with inline mic-slots is duplicated). Both halves
   * travel, so the duplicate shows exactly what its source shows today rather
   * than reverting to the default the moment it is made. No-op if the source key
   * has nothing.
   */
  async copyKey(srcKey: string, destKey: string, freshId: () => string): Promise<void> {
    assertSafeKey(srcKey, "srcKey");
    assertSafeKey(destKey, "destKey");
    let copied = false;
    await mutate((file) => {
      const srcDefaults = file.defaults.get(srcKey);
      const srcOverrides = file.overrides.get(srcKey);
      if (!srcDefaults && !srcOverrides) return null;
      if (srcDefaults) {
        const copy = new Map<string, Slot[]>();
        for (const [serviceTypeId, slots] of srcDefaults) {
          copy.set(serviceTypeId, slots.map((s) => ({ ...s, id: freshId() })));
        }
        file.defaults.set(destKey, copy);
      }
      if (srcOverrides) {
        const copy = new Map<string, SlotsOverride>();
        for (const [planId, override] of srcOverrides) {
          copy.set(planId, { ...override, slots: override.slots.map((s) => ({ ...s, id: freshId() })) });
        }
        file.overrides.set(destKey, copy);
      }
      copied = true;
      return file;
    });
    if (copied) console.log(`[slots-store] copyKey ${scrub(srcKey)} → ${scrub(destKey)}`);
  },

  /** Forget a key entirely — both halves. */
  async removeDisplay(key: string): Promise<void> {
    // Rejected rather than treated as a miss: a delete of "__proto__" once
    // reported (and logged) a removal of a key that never existed.
    assertSafeKey(key, "key");
    let removed = false;
    await mutate((file) => {
      if (!file.defaults.has(key) && !file.overrides.has(key)) return null;
      file.defaults.delete(key);
      file.overrides.delete(key);
      removed = true;
      return file;
    });
    if (removed) console.log(`[slots-store] removeDisplay ${scrub(key)}`);
  },
};
