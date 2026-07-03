// attendance-store.ts — Persists per-service attendance/occupancy trends, one
// record per service occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId
// ?? YYYY-MM-DD}` (same scheme as the SPL history store). Backed by the generic
// DataStore (attendance-history.json in the data dir).

import type { ServiceAttendance } from "../types/stage.js";
import { DataStore } from "./data-store.js";

interface AttendanceFile {
  services: Record<string, ServiceAttendance>;
}

class AttendanceStore {
  private store = new DataStore<AttendanceFile>("attendance-history.json", { services: {} });

  /** All recorded services, newest first (by start time). */
  async list(): Promise<ServiceAttendance[]> {
    const file = await this.store.load();
    return Object.values(file.services).sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    );
  }

  async get(serviceKey: string): Promise<ServiceAttendance | null> {
    const file = await this.store.load();
    return file.services[serviceKey] ?? null;
  }

  /** Insert or replace one service record (serialized read-modify-write). */
  async upsert(record: ServiceAttendance): Promise<void> {
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

export const attendanceStore = new AttendanceStore();
