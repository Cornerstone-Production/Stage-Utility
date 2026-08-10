// attendance-store.ts — Persists per-service attendance/occupancy trends, one
// record per service occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId
// ?? YYYY-MM-DD}` (same scheme as the SPL history store). Backed by the generic
// DataStore (attendance-history.json in the data dir).

import type { ServiceAttendance } from "../types/stage.js";
import { KeyedRecordStore } from "./keyed-record-store.js";

class AttendanceStore {
  private store = new KeyedRecordStore<ServiceAttendance>("attendance-history", "attendance-history.json", (r) => r.startedAt, "runtime");

  /** All recorded services, newest first (by start time). */
  async list(): Promise<ServiceAttendance[]> {
    return this.store.list();
  }

  async get(serviceKey: string): Promise<ServiceAttendance | null> {
    return this.store.get(serviceKey);
  }

  /** Insert or replace one service record (serialized read-modify-write). */
  async upsert(record: ServiceAttendance): Promise<void> {
    return this.store.upsert(record);
  }

  /** Delete one service record by key. Returns true if it existed. */
  async delete(serviceKey: string): Promise<boolean> {
    return this.store.delete(serviceKey);
  }
}

export const attendanceStore = new AttendanceStore();
