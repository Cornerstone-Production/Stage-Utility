// spl-history-store.ts — Persists per-item SPL recordings, one record per service
// occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`
// (the service-time id separates back-to-back services that share one plan). One
// file per service under spl-history/, so persisting a live service rewrites that
// service rather than the entire archive.

import type { ServiceSplHistory } from "../types/stage.js";
import { KeyedRecordStore } from "./keyed-record-store.js";
import { settingsStore } from "./settings-store.js";

/**
 * The record store, plus the one thing that is genuinely SPL's own.
 *
 * Extends rather than wraps: the four forwarding methods that used to sit here
 * restated the store's entire API and added nothing, and every time the store
 * grew a method this file had to be edited to expose it.
 *
 * The visible-metrics pair is not record storage at all — it lives in settings —
 * but it belongs to the SPL history surface the History tab reads, so it stays
 * beside it rather than becoming a fifth thing to import.
 */
class SplHistoryStore extends KeyedRecordStore<ServiceSplHistory> {
  constructor() {
    super("spl-history", "spl-history.json", (r) => r.startedAt, "runtime");
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
