// Persists the slot boards: what each slots screen and slots widget shows.
//
// A board is named, and any number of screens and widgets can point at one (a
// View's `boardId`, a slots-grid object's `config.boardId`). This file holds the
// boards' metadata and their layouts, in two halves, and the difference between
// the halves is the whole point of this file:
//
//   defaults   the layout a service type comes back to, per board, per service type
//   overrides  a layout saved for ONE Planning Center plan, used only while that
//              plan is the current one
//
// A swap made for one week used to be stored per service type, so it silently
// became every following week's board. An override expires by itself: the next
// plan of that type falls back to the default.
//
// Storage shape on disk (v4):
//   { version: 4,
//     boards:    Record<boardId, { name, columnWidthIn, createdAt }>,
//     defaults:  Record<boardId, Record<serviceTypeId, Slot[]>>,
//     overrides: Record<boardId, Record<planId, { serviceTypeId, sortDate, slots }>>,
//     pendingMerges?: Record<boardId, boardId> }
//
// `pendingMerges` exists only between the writes of an interrupted boot
// migration: each key is a board the migration merged into the value, kept
// until views.json has stopped pointing at it (see migrateSlotBoards).
//
// IN MEMORY all three are Maps, not records. The keys are request derived — a
// board id, a service type id, a plan id — and `obj[key] = value` with a key from
// a request is a property write onto an object somebody else chooses the name
// of. `Map.prototype.set` is not a property write at all, so the whole class of
// prototype-pollution question stops being asked. normaliseSlotsFile() builds the
// Maps on load and serialiseSlotsFile() turns them back into the records above on
// every write.
//
// v3 is the same file without `boards`, keyed by the screen that owned it: a
// view id, or an inline slots-grid's object id. Turning it into v4 needs the
// views (for names and pointers), so it is not done here: slot-boards.ts
// does it at boot, and until then a v3 file loads and saves as v3. A board's id
// is the v3 key, so the migration moves no slot data.
//
// Migration from v2:  Record<key, Record<serviceTypeId, Slot[]>>  → `defaults`
// Migration from v1:  Record<serviceTypeId, Slot[]>               → defaults["display-1"]
// Migration from v0:  Slot[] (flat array)                         → defaults["display-1"]["default"]
//
// `version` numbers the FILE ENVELOPE. It is unrelated to the "v2 -> v3 slot
// link" migration below, which renames a field inside an individual slot and has
// never had a version stamp of its own. Two independent lineages, same digits.

import type { Slot, SlotBoardMeta, SlotLink } from "../types/stage.js";
import { stripResolvedFields } from "./slot-resolver.js";
import { scrub } from "./scrub.js";
import { DataStore } from "./data-store.js";
import { assertSafeKey, isSafeKey } from "./safe-key.js";
import { isRecord } from "./is-record.js";
import { asArray, asObject, checked, refuse, required } from "./restore-check.js";

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

/** SERIALISED defaults — the on-disk and API shape. Outer key = board id, inner
 *  key = serviceTypeId. */
export type SlotsDefaults = Record<string, Record<string, Slot[]>>;

/** One plan's board. `sortDate` is the plan's PCO `sort_date`, recorded at save
 *  time so pruning can tell a stale override from a current one without asking
 *  PCO. Null when the writer did not know it. */
export interface SlotsOverride {
  serviceTypeId: string;
  sortDate: string | null;
  slots: Slot[];
}

/** SERIALISED overrides — the on-disk and API shape. Outer key = board id, inner
 *  key = planId. */
export type SlotsOverrides = Record<string, Record<string, SlotsOverride>>;

/** The file as this module holds it, as Maps. A v3 file has no boards yet. */
export interface SlotsFile {
  version: 3 | 4;
  /** boardId -> name, column width, creation time. Empty on a v3 file. */
  boards: Map<string, SlotBoardMeta>;
  /** boardId -> serviceTypeId -> slots */
  defaults: Map<string, Map<string, Slot[]>>;
  /** boardId -> planId -> override */
  overrides: Map<string, Map<string, SlotsOverride>>;
  /** Board -> the board a boot migration merged it into, while views.json may
   *  still point at it. Absent once the migration has finished. */
  pendingMerges?: Map<string, string>;
}

/** The envelope as it is written to disk. `boards` is absent on a v3 file. */
export interface SerialisedSlotsFile {
  version: 3 | 4;
  boards?: Record<string, SlotBoardMeta>;
  defaults: SlotsDefaults;
  overrides: SlotsOverrides;
  pendingMerges?: Record<string, string>;
}

/** One entry of a save across several boards — see `slotsStore.saveMany`. */
export interface SlotsWrite {
  boardId: string;
  target: SlotsTarget;
  slots: Slot[];
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
const store = new DataStore<unknown>("slots.json", {}, "config", { restoreCheck: checked(checkRestoredSlots) });

/**
 * A restored slots.json, read the way a load reads it — any of the five shapes,
 * through normaliseSlotsFile — and held to what the slot routes take: every
 * board, service type and plan key one assertSafeKey accepts, every slot list a
 * list of objects, every override naming its service type, and every board a
 * non-blank name and a column width that is a positive number or null.
 * Normalised on a copy, since the link migration edits slots in place; the file
 * is written as the backup holds it and migrated on the next load, as any old
 * file is.
 */
function checkRestoredSlots(raw: unknown): unknown {
  // A bare list is the first shape this file had (v0: one board's slots), which
  // normaliseSlotsFile still reads; every later shape is an object.
  if (!Array.isArray(raw)) asObject(raw, "the slots");
  const { file } = normaliseSlotsFile(structuredClone(raw));
  const refuseKey = (key: string, where: string): void => {
    if (!isSafeKey(key)) refuse(`${where} have a key that is not allowed ("${key.slice(0, 40)}")`);
  };
  const slotList = (v: unknown, what: string): void => {
    if (!asArray(v, what).every(isRecord)) refuse(`${what} must be a list of slots`);
  };
  // Checked on the RAW boards, not the normalised ones: normalising coerces a bad
  // name or width into something loadable, which is right for a file already on
  // disk and wrong for a backup about to replace it.
  const rawBoards = isRecord(raw) && raw.boards !== undefined ? asObject(raw.boards, "the slot boards") : {};
  for (const [id, b] of Object.entries(rawBoards)) {
    refuseKey(id, "the slot boards");
    const board = asObject(b, `slot board ${id}`);
    if (typeof board.name !== "string" || !board.name.trim()) refuse(`slot board ${id} has no name`);
    const w = board.columnWidthIn;
    if (w !== null && w !== undefined && !(typeof w === "number" && Number.isFinite(w) && w > 0)) {
      refuse(`slot board ${id}'s column width must be a positive number or null`);
    }
  }
  for (const [loser, survivor] of file.pendingMerges ?? []) {
    refuseKey(loser, "the pending board merges");
    refuseKey(survivor, "the pending board merges");
  }
  for (const [key, byType] of file.defaults) {
    refuseKey(key, "the slots");
    for (const [typeId, slots] of byType) {
      refuseKey(typeId, `the slots for ${key}`);
      slotList(slots, `the default slots for ${key}/${typeId}`);
    }
  }
  for (const [key, byPlan] of file.overrides) {
    refuseKey(key, "the slots");
    for (const [planId, o] of byPlan) {
      refuseKey(planId, `the slots for ${key}`);
      const override = asObject(o, `the slots for ${key} on plan ${planId}`);
      required(override.serviceTypeId, "string", `the service type of the slots for ${key} on plan ${planId}`);
      slotList(override.slots, `the slots for ${key} on plan ${planId}`);
    }
  }
  return raw;
}

function emptyFile(): SlotsFile {
  return { version: 4, boards: new Map(), defaults: new Map(), overrides: new Map() };
}

/**
 * Turn the in-memory Maps back into the record envelope written to disk, at the
 * version the file was read as: a v3 file stays v3 until the boot migration
 * writes it as v4, so a save made while that migration is pending (or after it
 * failed) cannot stamp a file v4 with no boards in it.
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
  if (file.version === 3) return { version: 3, defaults, overrides };
  return {
    version: 4,
    boards: Object.fromEntries(file.boards),
    defaults,
    overrides,
    ...(file.pendingMerges?.size ? { pendingMerges: Object.fromEntries(file.pendingMerges) } : {}),
  };
}

/** A board's metadata as read off disk, made loadable. The restore check is
 *  what refuses a bad one; a file already on disk is read as well as it can be,
 *  because dropping a board here would drop the operator's layouts with it. */
function toBoardMeta(id: string, raw: unknown): SlotBoardMeta {
  const b = isRecord(raw) ? raw : {};
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : id;
  const w = b.columnWidthIn;
  return {
    name,
    columnWidthIn: typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null,
    createdAt: typeof b.createdAt === "string" ? b.createdAt : "",
  };
}

function toBoardMap(raw: unknown): Map<string, SlotBoardMeta> {
  const out = new Map<string, SlotBoardMeta>();
  if (!isRecord(raw)) return out;
  for (const [id, b] of Object.entries(raw)) out.set(id, toBoardMeta(id, b));
  return out;
}

/** An interrupted migration's merges, as far as they read as board -> board.
 *  Anything else is dropped: the migration then keeps the board it named,
 *  which loses nothing. */
function toPendingMerges(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(raw)) return out;
  for (const [loser, survivor] of Object.entries(raw)) if (typeof survivor === "string" && survivor) out.set(loser, survivor);
  return out;
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
 * Decide which shape `raw` is and return it as a v3 or v4 file. Every shape
 * before v3 comes back as v3; v3 stays v3 (see the header).
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
      boards: new Map(),
      defaults: new Map([["display-1", new Map([["default", slots]])]]),
      overrides: new Map(),
    };
    migrateLinks([slots]);
    return { file, migrated: "v0 (flat array) → defaults/display-1/default" };
  }

  if (!isRecord(raw)) return { file: emptyFile(), migrated: null };

  // v4: the envelope with boards. A missing stamp beside all three halves is v4
  // for the same reason the pair of halves is v3 below.
  if (raw.version === 4 || (isRecord(raw.boards) && isRecord(raw.defaults) && isRecord(raw.overrides))) {
    const pendingMerges = toPendingMerges(raw.pendingMerges);
    const file: SlotsFile = {
      version: 4,
      boards: toBoardMap(raw.boards),
      defaults: toNestedMap<Slot[]>(raw.defaults),
      overrides: toNestedMap<SlotsOverride>(raw.overrides),
      ...(pendingMerges.size ? { pendingMerges } : {}),
    };
    const linksChanged = migrateLinks(allSlotSets(file));
    if (raw.version !== 4) return { file, migrated: "v4 envelope with no version stamp → restamped" };
    return { file, migrated: linksChanged ? "v2 links -> v3 position ranges" : null };
  }

  // v3: the envelope before boards. Halves are rebuilt into Maps rather than trusted,
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
      boards: new Map(),
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
      boards: new Map(),
      defaults: new Map([["display-1", byType]]),
      overrides: new Map(),
    };
    migrateLinks([...byType.values()]);
    return { file, migrated: "v1 (serviceType map) → defaults/display-1" };
  }

  // v2: Record<key, Record<serviceTypeId, Slot[]>>. Becomes the DEFAULTS, board
  // for board, with no overrides — the day this lands, nothing on any screen
  // changes.
  const file: SlotsFile = { version: 3, boards: new Map(), defaults: toNestedMap<Slot[]>(raw), overrides: new Map() };
  const linksChanged = migrateLinks(allSlotSets(file));
  // An empty file is not a migration — a first run must not write and log. It
  // is also not a v3 file with something to migrate: a fresh install starts v4.
  if (values.length === 0) return { file: emptyFile(), migrated: null };
  return { file, migrated: linksChanged ? "v2 → v3 (defaults + links)" : "v2 → v3 (defaults)" };
}

/** Normalise whatever shape is on disk, persisting a migration up to v3. */
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

/** Write one entry into the file — the body shared by the single-board writes
 *  and saveMany, so the two cannot drift on where a target lands. */
function writeInto(file: SlotsFile, w: SlotsWrite): void {
  const { boardId, target, slots } = w;
  if (target.kind === "default") {
    let byType = file.defaults.get(boardId);
    if (!byType) {
      byType = new Map();
      file.defaults.set(boardId, byType);
    }
    byType.set(target.serviceTypeId, stripResolvedFields(slots));
    return;
  }
  let byPlan = file.overrides.get(boardId);
  if (!byPlan) {
    byPlan = new Map();
    file.overrides.set(boardId, byPlan);
  }
  byPlan.set(target.planId, { serviceTypeId: target.serviceTypeId, sortDate: target.sortDate ?? null, slots: stripResolvedFields(slots) });
}

function assertTargetKeys(target: SlotsTarget): void {
  assertSafeKey(target.serviceTypeId, "serviceTypeId");
  if (target.kind === "plan") assertSafeKey(target.planId, "planId");
}

/** Every layout of one board, with fresh slot ids — what a duplicate holds. */
function copyLayouts(
  file: SlotsFile,
  srcId: string,
  freshId: () => string,
): { defaults: Map<string, Slot[]> | null; overrides: Map<string, SlotsOverride> | null } {
  const srcDefaults = file.defaults.get(srcId);
  const srcOverrides = file.overrides.get(srcId);
  let defaults: Map<string, Slot[]> | null = null;
  if (srcDefaults) {
    defaults = new Map();
    for (const [serviceTypeId, slots] of srcDefaults) {
      defaults.set(serviceTypeId, slots.map((s) => ({ ...s, id: freshId() })));
    }
  }
  let overrides: Map<string, SlotsOverride> | null = null;
  if (srcOverrides) {
    overrides = new Map();
    for (const [planId, override] of srcOverrides) {
      overrides.set(planId, { ...override, slots: override.slots.map((s) => ({ ...s, id: freshId() })) });
    }
  }
  return { defaults, overrides };
}

export const slotsStore = {
  /** The read failure that has this store refusing saves, or null. */
  refusingSaves() {
    return store.refusingSaves();
  },

  /**
   * The whole file, normalised, as a fresh object the caller may change — what
   * the boot migration reads. Nothing is written.
   */
  async loadFile(): Promise<SlotsFile> {
    const file = await loadNormalised();
    return {
      version: file.version,
      boards: new Map([...file.boards].map(([id, b]) => [id, { ...b }])),
      defaults: new Map([...file.defaults].map(([id, byType]) => [id, new Map(byType)])),
      overrides: new Map([...file.overrides].map(([id, byPlan]) => [id, new Map(byPlan)])),
      ...(file.pendingMerges ? { pendingMerges: new Map(file.pendingMerges) } : {}),
    };
  },

  /** Replace the whole file — the boot migration's writes. */
  async replaceFile(file: SlotsFile): Promise<void> {
    await store.save(serialiseSlotsFile(file));
  },

  /** Every board's metadata. Empty on a file the boot migration has not reached. */
  async listBoards(): Promise<Map<string, SlotBoardMeta>> {
    const file = await loadNormalised();
    return new Map([...file.boards].map(([id, b]) => [id, { ...b }]));
  },

  /**
   * Add a board. `layouts` is its starting content — a copy of another board,
   * or a saved layout placed under one target — and absent for a blank board.
   * Refuses an id already in use rather than overwrite a board.
   */
  async createBoard(
    boardId: string,
    meta: SlotBoardMeta,
    layouts?: { defaults?: Map<string, Slot[]> | null; overrides?: Map<string, SlotsOverride> | null },
  ): Promise<void> {
    assertSafeKey(boardId, "boardId");
    await mutate((file) => {
      if (file.boards.has(boardId) || file.defaults.has(boardId) || file.overrides.has(boardId)) {
        throw new Error(`slot board ${boardId} already exists`);
      }
      file.version = 4;
      file.boards.set(boardId, { ...meta });
      if (layouts?.defaults?.size) file.defaults.set(boardId, layouts.defaults);
      if (layouts?.overrides?.size) file.overrides.set(boardId, layouts.overrides);
      return file;
    });
  },

  /** Change a board's name and/or column width. Resolves the metadata as saved,
   *  or null when there is no such board. */
  async updateBoard(
    boardId: string,
    patch: { name?: string; columnWidthIn?: number | null },
  ): Promise<SlotBoardMeta | null> {
    assertSafeKey(boardId, "boardId");
    let saved: SlotBoardMeta | null = null;
    await mutate((file) => {
      const cur = file.boards.get(boardId);
      if (!cur) return null;
      saved = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.columnWidthIn !== undefined ? { columnWidthIn: patch.columnWidthIn } : {}),
      };
      file.boards.set(boardId, saved);
      return file;
    });
    return saved;
  },

  /**
   * Copy a board — every service type's default and every plan's override,
   * with fresh slot ids — to a new board. Resolves false when the source does
   * not exist.
   */
  async duplicateBoard(srcId: string, destId: string, meta: SlotBoardMeta, freshId: () => string): Promise<boolean> {
    assertSafeKey(srcId, "srcId");
    assertSafeKey(destId, "destId");
    let copied = false;
    await mutate((file) => {
      if (!file.boards.has(srcId)) return null;
      if (file.boards.has(destId) || file.defaults.has(destId) || file.overrides.has(destId)) {
        throw new Error(`slot board ${destId} already exists`);
      }
      const { defaults, overrides } = copyLayouts(file, srcId, freshId);
      file.boards.set(destId, { ...meta });
      if (defaults) file.defaults.set(destId, defaults);
      if (overrides) file.overrides.set(destId, overrides);
      copied = true;
      return file;
    });
    return copied;
  },

  /** Forget a board entirely: its metadata and both halves. Resolves false when
   *  there was nothing under that id. */
  async deleteBoard(boardId: string): Promise<boolean> {
    // Rejected rather than treated as a miss: a delete of "__proto__" once
    // reported (and logged) a removal of a key that never existed.
    assertSafeKey(boardId, "boardId");
    let removed = false;
    await mutate((file) => {
      if (!file.boards.has(boardId) && !file.defaults.has(boardId) && !file.overrides.has(boardId)) return null;
      file.boards.delete(boardId);
      file.defaults.delete(boardId);
      file.overrides.delete(boardId);
      removed = true;
      return file;
    });
    return removed;
  },

  /**
   * Every board's DEFAULTS, for every service type — what view-export carries.
   *
   * Overrides deliberately do NOT travel in a bundle: an override is one plan's
   * exception, and the plan ids it is keyed by mean nothing on the far end.
   */
  async allDefaults(): Promise<SlotsDefaults> {
    return serialiseSlotsFile(await loadNormalised()).defaults;
  },

  /** Every board's overrides — for pruning and for diagnostics. */
  async allOverrides(): Promise<SlotsOverrides> {
    return serialiseSlotsFile(await loadNormalised()).overrides;
  },

  async getDefault(boardId: string, serviceTypeId: string): Promise<Slot[]> {
    // A read, but still request-reachable, and the caller of a rejected key is
    // confused about something: this signature says it returns Slot[].
    assertSafeKey(boardId, "boardId");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    const file = await loadNormalised();
    return file.defaults.get(boardId)?.get(serviceTypeId) ?? [];
  },

  async setDefault(boardId: string, serviceTypeId: string, slots: Slot[]): Promise<void> {
    // Both keys arrive from a request. Rejected rather than sanitised: no
    // legitimate board or service type is called "__proto__".
    assertSafeKey(boardId, "boardId");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    await mutate((file) => {
      writeInto(file, { boardId, target: { kind: "default", serviceTypeId }, slots });
      return file;
    });
  },

  /**
   * One plan's layout, or null.
   *
   * Both keys are asserted on the READ as well as the write. A caller that got
   * here with "__proto__" is confused, and the callers that branch on "is there
   * an override?" (clearOverride, promoteOverride, getSlotTargets) would read a
   * junk answer as yes.
   */
  async getOverride(boardId: string, planId: string): Promise<SlotsOverride | null> {
    assertSafeKey(boardId, "boardId");
    assertSafeKey(planId, "planId");
    const file = await loadNormalised();
    return file.overrides.get(boardId)?.get(planId) ?? null;
  },

  async setOverride(
    boardId: string,
    planId: string,
    serviceTypeId: string,
    slots: Slot[],
    sortDate: string | null = null,
  ): Promise<void> {
    assertSafeKey(boardId, "boardId");
    assertSafeKey(planId, "planId");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    await mutate((file) => {
      writeInto(file, { boardId, target: { kind: "plan", planId, serviceTypeId, sortDate }, slots });
      return file;
    });
  },

  /**
   * Several boards' layouts in ONE write: every key is checked before anything
   * changes, and the file is written once, so a save across boards lands whole
   * or not at all. The caller has already decided every entry is valid; this
   * only refuses a key that could not be stored.
   */
  async saveMany(writes: SlotsWrite[]): Promise<void> {
    for (const w of writes) {
      assertSafeKey(w.boardId, "boardId");
      assertTargetKeys(w.target);
    }
    if (writes.length === 0) return;
    await mutate((file) => {
      for (const w of writes) writeInto(file, w);
      return file;
    });
  },

  /** Drop one plan's override. Resolves TRUE when there was one to drop, so the
   *  caller can tell "reverted" from "there was nothing to revert". */
  async clearOverride(boardId: string, planId: string): Promise<boolean> {
    // Asserted here as well as inside getOverride: this is a DELETE reachable
    // from the LAN, and it reported true for `__proto__` with the file untouched.
    assertSafeKey(boardId, "boardId");
    assertSafeKey(planId, "planId");
    const existing = await this.getOverride(boardId, planId);
    if (!existing) return false;
    await mutate((file) => {
      const byPlan = file.overrides.get(boardId);
      if (!byPlan?.has(planId)) return null;
      byPlan.delete(planId);
      if (byPlan.size === 0) file.overrides.delete(boardId);
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
  async promoteOverride(boardId: string, planId: string): Promise<SlotsOverride | null> {
    // Before the read, not after it: an unsafe planId used to reach the delete
    // below on Object.prototype and throw a TypeError, which the route turned
    // into a 404.
    assertSafeKey(boardId, "boardId");
    assertSafeKey(planId, "planId");
    const existing = await this.getOverride(boardId, planId);
    if (!existing) return null;
    assertSafeKey(existing.serviceTypeId, "serviceTypeId");
    await mutate((file) => {
      const byPlan = file.overrides.get(boardId);
      const override = byPlan?.get(planId);
      if (!byPlan || !override) return null;
      writeInto(file, { boardId, target: { kind: "default", serviceTypeId: override.serviceTypeId }, slots: override.slots });
      byPlan.delete(planId);
      if (byPlan.size === 0) file.overrides.delete(boardId);
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
  async resolve(boardId: string, serviceTypeId: string | null, planId: string | null): Promise<Slot[]> {
    if (!serviceTypeId) return [];
    // Skipped rather than thrown, unlike every write above: this is the read
    // every screen's rows come through, and an unsafe key reaching it means some
    // caller is confused, not that the wall should go blank.
    if (!isSafeKey(boardId) || !isSafeKey(serviceTypeId)) return [];
    const file = await loadNormalised();
    if (planId && isSafeKey(planId)) {
      const override = file.overrides.get(boardId)?.get(planId);
      if (override && override.serviceTypeId === serviceTypeId) return override.slots;
    }
    return file.defaults.get(boardId)?.get(serviceTypeId) ?? [];
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

  // One-time recovery for the primary display's board: if the active service
  // type has no default slots but the legacy "default" bucket has some, adopt
  // them and clear the bucket. Returns the RESOLVED rows, so a plan override
  // still wins.
  async adoptDefaultInto(boardId: string, serviceTypeId: string, planId: string | null): Promise<Slot[]> {
    assertSafeKey(boardId, "boardId");
    assertSafeKey(serviceTypeId, "serviceTypeId");
    let adopted = 0;
    await mutate((file) => {
      const byType = file.defaults.get(boardId) ?? new Map<string, Slot[]>();
      const existing = byType.get(serviceTypeId) ?? [];
      const fallback = byType.get("default") ?? [];
      if (existing.length > 0 || fallback.length === 0) return null;
      byType.set(serviceTypeId, fallback);
      byType.delete("default");
      file.defaults.set(boardId, byType);
      adopted = fallback.length;
      return file;
    });
    if (adopted > 0) {
      console.log(
        `[slots-store] adoptDefaultInto board=${scrub(boardId)} serviceType=${scrub(serviceTypeId)} (${adopted} slots)`,
      );
    }
    return this.resolve(boardId, serviceTypeId, planId);
  },
};
