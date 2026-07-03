// service-timeline-store.ts — Persists the ACTUAL service rundown timing, one
// record per service occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId
// ?? YYYY-MM-DD}` (same scheme as the SPL + attendance stores, so the three align
// per service). Backed by the generic DataStore (service-timeline.json).

import type { ServiceTimeline } from "../types/stage.js";
import { DataStore } from "./data-store.js";

interface TimelineFile {
  services: Record<string, ServiceTimeline>;
}

class ServiceTimelineStore {
  private store = new DataStore<TimelineFile>("service-timeline.json", { services: {} });

  /** All recorded services, newest first (by start time). */
  async list(): Promise<ServiceTimeline[]> {
    const file = await this.store.load();
    return Object.values(file.services).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  async get(serviceKey: string): Promise<ServiceTimeline | null> {
    const file = await this.store.load();
    return file.services[serviceKey] ?? null;
  }

  /** Insert or replace one service record (serialized read-modify-write). */
  async upsert(record: ServiceTimeline): Promise<void> {
    await this.store.update((file) => ({
      services: { ...file.services, [record.serviceKey]: record },
    }));
  }

  /** Delete one service record by key. Returns true if it existed. */
  async delete(serviceKey: string): Promise<boolean> {
    let existed = false;
    await this.store.update((file) => {
      existed = serviceKey in file.services;
      if (!existed) return file;
      const services = { ...file.services };
      delete services[serviceKey];
      return { services };
    });
    return existed;
  }
}

export const serviceTimelineStore = new ServiceTimelineStore();
