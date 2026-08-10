// spl-history-store.ts — Persists per-item SPL recordings, one record per service
// occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`
// (the service-time id separates back-to-back services that share one plan). Backed
// by KeyedRecordStore: one file per service under spl-history/, so persisting a
// live service rewrites that service rather than the entire archive.

import type { ServiceSplHistory } from "../types/stage.js";
import { KeyedRecordStore } from "./keyed-record-store.js";
import { settingsStore } from "./settings-store.js";

class SplHistoryStore {
  private store = new KeyedRecordStore<ServiceSplHistory>("spl-history", "spl-history.json", (r) => r.startedAt, "runtime");

  /** All recorded services, newest first (by start time). */
  async list(): Promise<ServiceSplHistory[]> {
    return this.store.list();
  }

  async get(serviceKey: string): Promise<ServiceSplHistory | null> {
    return this.store.get(serviceKey);
  }

  /** Insert or replace one service record — one file, not the whole history. */
  async upsert(record: ServiceSplHistory): Promise<void> {
    return this.store.upsert(record);
  }

  /** Delete one service record by key. Returns true if it existed. */
  async delete(serviceKey: string): Promise<boolean> {
    return this.store.delete(serviceKey);
  }

  /** Forget the cached copy (after an import writes files directly). */
  invalidate(): void {
    this.store.invalidate();
  }

  /** Smaart metric keys the History tab should surface (empty = auto default). */
  async getVisibleMetrics(): Promise<string[]> {
    const s = await settingsStore.get();
    return s.splVisibleMetrics ?? [];
  }

  async setVisibleMetrics(metrics: string[]): Promise<string[]> {
    const clean = metrics.filter((m): m is string => typeof m === "string");
    await settingsStore.patch({ splVisibleMetrics: clean });
    return clean;
  }
}

export const splHistoryStore = new SplHistoryStore();
