// service-timeline-store.ts — Persists the ACTUAL service rundown timing, one
// record per service occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId
// ?? YYYY-MM-DD}` (same scheme as the SPL and attendance stores, so the three
// align per service). One file per service under service-timeline/.

import type { ServiceTimeline } from "../types/stage.js";
import { KeyedRecordStore } from "./keyed-record-store.js";

/** This IS the KeyedRecordStore — see attendance-store.ts for why. */
export const serviceTimelineStore = new KeyedRecordStore<ServiceTimeline>(
  "service-timeline",
  "service-timeline.json",
  (r) => r.startedAt,
  "runtime",
);
