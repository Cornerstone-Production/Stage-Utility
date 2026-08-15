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

const store = new DataStore<NotesFile>("notes.json", {}, "config");

let cache: NotesFile = {};
let loaded = false;

export const notesStore = {
  async init(): Promise<void> {
    cache = await store.load();
    loaded = true;
  },

  /** Everything, for the state broadcast. */
  all(): NotesFile {
    return cache;
  },

  get(objectId: string): NotesContent {
    return cache[objectId] ?? {};
  },

  /**
   * Replace one object's content.
   *
   * Awaited, and the write is NOT fire-and-forget: this is the operator's typing,
   * and "it looked saved until the next restart" is the failure this repository
   * has already had with a config write. The caller gets the rejection.
   */
  async set(objectId: string, content: NotesContent): Promise<void> {
    if (!loaded) await notesStore.init();
    cache = { ...cache, [objectId]: content };
    await store.save(cache);
  },

  /** Forget an object's content — called when the object itself is deleted, so
   *  notes.json does not accumulate orphans for every object ever created. */
  async forget(objectIds: readonly string[]): Promise<void> {
    if (!loaded) await notesStore.init();
    const next = { ...cache };
    let changed = false;
    for (const id of objectIds) {
      if (id in next) { delete next[id]; changed = true; }
    }
    if (!changed) return;
    cache = next;
    await store.save(cache);
  },
};
