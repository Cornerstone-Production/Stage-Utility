// reconcile-records.ts — On startup, finalize any history record left open
// (endedAt == null) by a prior run that didn't close it (crash, or a process
// restart after a service — the in-memory "current record" is gone, so nothing
// would ever close the on-disk record and it shows "recording…" forever).
//
// Safe: at boot the service can't actually be live (we weren't running), and if it
// IS still live, the recorder resumes the record on the next tick (ensureRecord
// clears endedAt again). So this only closes true orphans.

import { attendanceStore } from "./attendance-store.js";
import { splHistoryStore } from "./spl-history-store.js";
import { serviceTimelineStore } from "./service-timeline-store.js";

interface OpenRecord {
  startedAt: string;
  endedAt: string | null;
  samples?: { t: string }[];
  items?: { startedAt?: string; endedAt?: string | null }[];
}

/** Best "end" for an orphan = the latest timestamp it actually holds (last sample /
 *  item), falling back to when it started — never a boot-time "now" that could be
 *  days later than the real end. */
function latestTimestamp(rec: OpenRecord): string {
  let best = Date.parse(rec.startedAt);
  if (!Number.isFinite(best)) best = Date.now();
  for (const s of rec.samples ?? []) {
    const p = Date.parse(s.t);
    if (Number.isFinite(p) && p > best) best = p;
  }
  for (const it of rec.items ?? []) {
    for (const v of [it.endedAt, it.startedAt]) {
      const p = v ? Date.parse(v) : NaN;
      if (Number.isFinite(p) && p > best) best = p;
    }
  }
  return new Date(best).toISOString();
}

export async function reconcileOpenRecords(): Promise<void> {
  let closed = 0;

  for (const rec of await attendanceStore.list()) {
    if (rec.endedAt == null) {
      rec.endedAt = latestTimestamp(rec);
      await attendanceStore.upsert(rec);
      closed++;
    }
  }
  for (const rec of await splHistoryStore.list()) {
    if (rec.endedAt == null) {
      rec.endedAt = latestTimestamp(rec);
      await splHistoryStore.upsert(rec);
      closed++;
    }
  }
  for (const rec of await serviceTimelineStore.list()) {
    if (rec.endedAt == null) {
      const end = latestTimestamp(rec);
      rec.endedAt = end;
      for (const it of rec.items) if (it.endedAt == null) it.endedAt = end; // close trailing live item
      await serviceTimelineStore.upsert(rec);
      closed++;
    }
  }

  if (closed > 0) console.log(`[reconcile] closed ${closed} orphaned open record(s) from a prior run`);
}
