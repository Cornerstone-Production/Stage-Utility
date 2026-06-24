// spl-history-store.ts — Persists per-item SPL recordings, one record per service
// occurrence, keyed by `${serviceTypeId}:${planId}:${YYYY-MM-DD}`. Backed by the
// generic DataStore (spl-history.json in the data dir).

import type { ServiceSplHistory } from "../types/stage.js";
import { DataStore } from "./data-store.js";

interface SplHistoryFile {
  services: Record<string, ServiceSplHistory>;
}

class SplHistoryStore {
  private store = new DataStore<SplHistoryFile>("spl-history.json", { services: {} });

  /** All recorded services, newest first (by start time). */
  async list(): Promise<ServiceSplHistory[]> {
    const file = await this.store.load();
    return Object.values(file.services).sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    );
  }

  async get(serviceKey: string): Promise<ServiceSplHistory | null> {
    const file = await this.store.load();
    return file.services[serviceKey] ?? null;
  }

  /** Insert or replace one service record (serialized read-modify-write). */
  async upsert(record: ServiceSplHistory): Promise<void> {
    await this.store.update((file) => ({
      services: { ...file.services, [record.serviceKey]: record },
    }));
  }
}

export const splHistoryStore = new SplHistoryStore();
