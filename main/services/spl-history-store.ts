// spl-history-store.ts — Persists per-item SPL recordings, one record per service
// occurrence, keyed by `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`
// (the service-time id separates back-to-back services that share one plan). One
// file per service under spl-history/, so persisting a live service rewrites that
// service rather than the entire archive.

import type { ServiceSplHistory, SplServiceSummary } from "../types/stage.js";
import { KeyedRecordStore } from "./keyed-record-store.js";
import { combineLeq } from "./spl-leq.js";
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

  /**
   * Every service reduced to one Leq per metric — what the trend line reads.
   *
   * Server-side because the reduction throws away almost everything: the records
   * hold every item of every service and this is one row each. Doing it in the
   * client would mean sending the archive to a Home tile that mounts on every
   * app load, which is the always-on traffic this app tries not to make.
   *
   * ENERGY-WEIGHTED, via the same `combineLeq` the item stats were built with.
   * A plain mean of the items would let a 30-second welcome count as much as a
   * 25-minute sermon and report a level nobody in the room experienced.
   *
   * A metric no item reported is absent rather than present-and-null: the caller
   * builds its picker from the keys that are actually here, and an empty key
   * would offer a metric with nothing behind it.
   *
   * `endedAt` rides along unreduced — this is the one field the reduction does
   * NOT throw away — so the caller can tell a settled level from a still-live
   * one without a second lookup against a different recorder's records.
   */
  async summary(): Promise<SplServiceSummary[]> {
    const records = await this.list();
    return records.map((r) => {
      const keys = new Set<string>();
      for (const item of r.items) for (const k of Object.keys(item.metrics ?? {})) keys.add(k);
      const metrics: Record<string, { leq: number; count: number }> = {};
      for (const key of keys) {
        const parts = r.items.map((it) => {
          const stat = it.metrics?.[key];
          return { leq: stat?.leq ?? null, count: stat?.count ?? 0 };
        });
        const leq = combineLeq(parts);
        if (leq == null) continue;
        const count = parts.reduce((n, p) => n + (p.leq == null ? 0 : p.count), 0);
        metrics[key] = { leq, count };
      }
      return {
        serviceKey: r.serviceKey,
        serviceTypeId: r.serviceTypeId,
        serviceTypeName: r.serviceTypeName ?? null,
        serviceDate: r.serviceDate,
        endedAt: r.endedAt,
        metrics,
      };
    });
  }

  /** Smaart metric keys the History tab should surface (empty = auto default). */
  async getVisibleMetrics(): Promise<string[]> {
    const s = await settingsStore.get();
    return s.splVisibleMetrics ?? [];
  }

  /**
   * Whether History draws the SPL trend line, and which metric it plots.
   *
   * Beside the visible-metrics pair and for the same stated reason: it is not
   * record storage, it lives in settings, and it belongs to the SPL history
   * surface the History tab reads. A third get/set channel through the stage
   * controller for two fields would be plumbing for its own sake.
   */
  async getTrendPrefs(): Promise<{ shown: boolean; metric: string | null }> {
    const s = await settingsStore.get();
    return { shown: s.splTrendShown ?? false, metric: s.splTrendMetric ?? null };
  }

  async setTrendPrefs(p: {
    shown?: unknown;
    metric?: unknown;
  }): Promise<{ shown: boolean; metric: string | null }> {
    const patch: { splTrendShown?: boolean; splTrendMetric?: string | null } = {};
    if (typeof p.shown === "boolean") patch.splTrendShown = p.shown;
    // `null` clears back to the preferred default and is a real choice, so it is
    // accepted; anything else that is not a string is ignored rather than stored.
    if (p.metric === null || typeof p.metric === "string") patch.splTrendMetric = p.metric;
    if (Object.keys(patch).length) await settingsStore.patch(patch);
    return this.getTrendPrefs();
  }

  async setVisibleMetrics(metrics: string[]): Promise<string[]> {
    const clean = metrics.filter((m): m is string => typeof m === "string");
    await settingsStore.patch({ splVisibleMetrics: clean });
    return clean;
  }
}

export const splHistoryStore = new SplHistoryStore();
