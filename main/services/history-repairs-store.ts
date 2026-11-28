// history-repairs-store.ts — which one-time repairs of recorded history have run.
//
// A repair of records an older release wrote wrongly runs at boot until it has
// gone through every record once, then never again: see reconcile-records.ts.
// Its own records are a natural no-op the second time; the marker is what keeps
// a record it could not measure from being looked at, and logged, on every boot.
//
// RUNTIME, not config. It describes the history on THIS machine, which a config
// restore does not carry, so restoring it elsewhere would claim a repair of
// records that were never looked at.

import { DataStore } from "./data-store.js";

/** Repair id -> when it finished. */
export type HistoryRepairs = Record<string, string>;

export const historyRepairsStore = new DataStore<HistoryRepairs>("history-repairs.json", {}, "runtime");
