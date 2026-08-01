// service-timeline-store.ts — Persists the ACTUAL service rundown timing, one
// record per service occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId
// ?? YYYY-MM-DD}` (same scheme as the SPL + attendance stores, so the three align
// per service). Backed by the generic DataStore (service-timeline.json).

import type { ServiceTimeline } from "../types/stage.js";
import { KeyedRecordStore } from "./keyed-record-store.js";

class ServiceTimelineStore {
  private store = new KeyedRecordStore<ServiceTimeline>("service-timeline", "service-timeline.json", (r) => r.startedAt);

  /** All recorded services, newest first (by start time). */
  async list(): Promise<ServiceTimeline[]> {
    return this.store.list();
  }

  async get(serviceKey: string): Promise<ServiceTimeline | null> {
    return this.store.get(serviceKey);
  }

  /** Insert or replace one service record (serialized read-modify-write). */
  async upsert(record: ServiceTimeline): Promise<void> {
    return this.store.upsert(record);
  }

  /** Delete one service record by key. Returns true if it existed. */
  async delete(serviceKey: string): Promise<boolean> {
    return this.store.delete(serviceKey);
  }
}

export const serviceTimelineStore = new ServiceTimelineStore();
