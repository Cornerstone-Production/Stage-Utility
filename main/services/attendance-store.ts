// attendance-store.ts — Persists per-service attendance/occupancy trends, one
// record per service occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId
// ?? YYYY-MM-DD}` (same scheme as the SPL and service-timeline stores, so the
// three align per service). One file per service under attendance-history/.

import type { ServiceAttendance } from "../types/stage.js";
import { KeyedRecordStore } from "./keyed-record-store.js";

/**
 * This IS the KeyedRecordStore.
 *
 * The class that used to sit here forwarded list/get/upsert/delete verbatim —
 * the store's entire API, restated — and the timeline store held an identical
 * copy. Neither added behaviour, and both had to be edited whenever the store
 * itself grew: `invalidate()` reached the SPL store and never these two.
 */
export const attendanceStore = new KeyedRecordStore<ServiceAttendance>(
  "attendance-history",
  "attendance-history.json",
  (r) => r.startedAt,
  "runtime",
);
