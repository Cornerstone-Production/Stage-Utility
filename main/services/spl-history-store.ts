// spl-history-store.ts — Persists per-item SPL recordings, one record per service
// occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`
// (the service-time id separates back-to-back services that share one plan). Backed
// by the generic DataStore (spl-history.json in the data dir).

import type { ServiceSplHistory } from "../types/stage.js";
import { DataStore } from "./data-store.js";
import { settingsStore } from "./settings-store.js";

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
