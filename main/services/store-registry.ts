// store-registry.ts — every persisted store, and whether a backup should carry it.
//
// The rule this enforces: a store is either the operator's WORK, which must
// survive a rebuild, or an OBSERVATION of what happened, which must not be
// restored onto another machine. Getting that wrong is silent both ways — a
// forgotten config store is simply missing after a restore, and a history store
// wrongly included fabricates services a box never ran.
//
// It used to be two hand-maintained arrays in config-snapshot.ts, guarded by a
// test that scanned the source for `new DataStore<…>(`. That guard had holes it
// could not see past:
//
//   - the regex could not cross a `>`, so a store with a NESTED generic was
//     invisible. signal-store.ts declares `new DataStore<Record<string,
//     SignalState>>("signals.json", …)` and was missed — the scan found 22 of 23
//     stores, and CI was green only because someone had independently remembered
//     to classify that one.
//   - the directory read was not recursive, so anything under archive/, routes/
//     or update/ would never be seen at all.
//   - a store written without a type argument would not match either.
//
// Classification is now a constructor argument. A store cannot be created
// without stating which it is, the type checker enforces it, and the list is
// derived from what actually exists rather than from what someone remembered to
// add. See stores.ts for why registration is not lazy.

/** Which half of a backup a store belongs to. */
export type StoreClass =
  /** The operator's work: settings, views, layouts, patch sheets. Restored. */
  | "config"
  /** Recorded history and logs: observations of what happened. Not restored. */
  | "runtime";

export interface RegisteredStore {
  /** Filename for a DataStore; the legacy single-document name for a keyed one. */
  filename: string;
  classification: StoreClass;
  /** A keyed store is a DIRECTORY of per-service files, not one file — the
   *  snapshot reader has to dispatch on this rather than assume readFile. */
  kind: "file" | "directory";
}

const registry = new Map<string, RegisteredStore>();

/** Called by DataStore / KeyedRecordStore on construction. */
export function registerStore(entry: RegisteredStore): void {
  const existing = registry.get(entry.filename);
  if (existing && existing.classification !== entry.classification) {
    // Two stores over one filename disagreeing about whether it is backed up is
    // never intentional, and whichever loaded second would silently win.
    throw new Error(
      `[store-registry] ${entry.filename} registered as both ${existing.classification} and ${entry.classification}`,
    );
  }
  registry.set(entry.filename, entry);
}

export function allStores(): RegisteredStore[] {
  return [...registry.values()];
}

export function storesOfClass(classification: StoreClass): RegisteredStore[] {
  return allStores().filter((s) => s.classification === classification);
}

/** Filenames a config snapshot carries. Derived, never hand-maintained. */
export function configFilenames(): string[] {
  return storesOfClass("config").map((s) => s.filename);
}
