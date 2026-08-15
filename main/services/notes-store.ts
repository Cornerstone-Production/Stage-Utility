// What an operator typed into a notes or checklist object on a console.
//
// Classified "config", not "runtime". These hold the operator's own work — the
// pre-service checklist someone built over a season, the note left for the next
// volunteer — and losing them to a reinstall because they read as "just runtime
// state" would be exactly the kind of quiet data loss this repository has a rule
// against. Being "config" is also what puts them in every backup: the allowlist
// is derived from this classification rather than hand-maintained, so declaring
// it here is the whole of the job.
//
// Keyed by LAYOUT OBJECT id, not by view: an object keeps its content when the
// view is renamed or its layout rearranged, and a duplicated view gets fresh ids
// and therefore fresh (empty) content rather than silently sharing text with the
// original.

import { DataStore } from "./data-store.js";

/** One checklist row. `done` is the operator's tick; text is theirs to edit. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface NotesContent {
  /** Free text for a `notes` object. */
  text?: string;
  /** Rows for a `checklist` object. */
  items?: ChecklistItem[];
}

/** objectId → what is in it. */
type NotesFile = Record<string, NotesContent>;

/**
 * Layout object ids as this app generates them.
 *
 * The id is chosen by the CLIENT — it comes from the layout, which arrives over
 * HTTP — and it is used as a property name. Without this, posting an objectId of
 * "__proto__" writes through to Object.prototype and every plain object in the
 * process gains a `text` field. That is prototype pollution, and it is a real
 * remote vector rather than a theoretical one: the notes route accepts any
 * string.
 *
 * Ids are generated as short slugs, so an allowlist is both correct and cheap;
 * anything else is rejected rather than sanitised, because a "cleaned" id would
 * silently write to the wrong key.
 */
const SAFE_OBJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Names that are letters and underscores — and so pass the pattern above — but
 * are never legitimate object ids and are exactly what an attacker reaches for.
 *
 * The pattern alone is NOT enough, which is the trap: "__proto__" is made
 * entirely of characters the allowlist permits.
 */
const FORBIDDEN_IDS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeObjectId(objectId: string): void {
  if (!SAFE_OBJECT_ID.test(objectId) || FORBIDDEN_IDS.has(objectId)) {
    throw new Error(`notes: refusing an unsafe object id "${objectId.slice(0, 32)}"`);
  }
}

const store = new DataStore<NotesFile>("notes.json", {}, "config");

/**
 * A MAP, not an object.
 *
 * The key comes from the client, and a Map has no prototype-key semantics at
 * all: map.set("__proto__", x) stores an ordinary entry and reaches nothing.
 * That removes the whole class of remote property injection rather than
 * defending against one instance of it — the earlier null-prototype object was
 * safe in practice but still wrote to a computed property name, which is both
 * harder to prove and harder to read.
 *
 * The validation above is kept anyway: it rejects nonsense ids at the door, so
 * a typo cannot silently create an entry nothing will ever read.
 */
let cache = new Map<string, NotesContent>();
let loaded = false;

/** Map -> plain object for the JSON file. Object.fromEntries defines
 *  properties rather than assigning them, so it cannot trigger a setter. */
function toFile(map: ReadonlyMap<string, NotesContent>): NotesFile {
  return Object.fromEntries(map) as NotesFile;
}

export const notesStore = {
  async init(): Promise<void> {
    cache = new Map(Object.entries(await store.load()));
    loaded = true;
  },

  /** Everything, for the state broadcast. */
  all(): NotesFile {
    return toFile(cache);
  },

  get(objectId: string): NotesContent {
    return cache.get(objectId) ?? {};
  },

  /**
   * Replace one object's content.
   *
   * Awaited, and the write is NOT fire-and-forget: this is the operator's typing,
   * and "it looked saved until the next restart" is the failure this repository
   * has already had with a config write. The caller gets the rejection.
   */
  async set(objectId: string, content: NotesContent): Promise<void> {
    assertSafeObjectId(objectId);
    if (!loaded) await notesStore.init();
    cache.set(objectId, content);
    await store.save(toFile(cache));
  },

  /** Forget an object's content — called when the object itself is deleted, so
   *  notes.json does not accumulate orphans for every object ever created. */
  async forget(objectIds: readonly string[]): Promise<void> {
    if (!loaded) await notesStore.init();
    let changed = false;
    for (const id of objectIds) {
      if (cache.delete(id)) changed = true;
    }
    if (!changed) return;
    await store.save(toFile(cache));
  },
};
