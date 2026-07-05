// history-edit.ts — Post-hoc correction of finalized service records. Recordings
// are otherwise write-once; these let an operator fix a bad capture (e.g. a service
// that kept "recording" through a parked Stream Buffer) instead of only deleting it.
//
// All three records (timeline, attendance, SPL) share a serviceKey, so editing the
// service window applies to each: the raw samples are kept, so aggregates re-derive.

import type { ServiceAttendance } from "../types/stage.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { attendanceStore } from "./attendance-store.js";
import { splHistoryStore } from "./spl-history-store.js";
import { broadcast } from "./broadcaster.js";

/** Re-derive attendance aggregates from the (possibly trimmed) sample series. Note:
 *  totalAttendance is a raw daily counter we can't reconstruct from baselined
 *  samples, so it's left as-is. */
function recomputeAttendance(att: ServiceAttendance): void {
  const s = att.samples;
  att.peakAttendance = s.reduce((m, x) => Math.max(m, x.attendance), 0);
  att.peakOccupancy = s.reduce((m, x) => Math.max(m, x.occupancy), 0);
  att.minOccupancy = s.length ? s.reduce((m, x) => Math.min(m, x.occupancy), s[0].occupancy) : null;
  att.lastAttendance = s.length ? s[s.length - 1].attendance : 0;
  att.lastOccupancy = s.length ? s[s.length - 1].occupancy : 0;
}

/** Adjust a service's start/end window across all three records: trim the timeline's
 *  trailing items, drop attendance samples / SPL items outside the window, and
 *  recompute derived values. Any of start/end may be omitted to leave it unchanged. */
export async function editServiceWindow(
  serviceKey: string,
  opts: { startedAt?: string; endedAt?: string },
): Promise<void> {
  const startMs = opts.startedAt ? Date.parse(opts.startedAt) : null;
  const endMs = opts.endedAt ? Date.parse(opts.endedAt) : null;
  const inWindow = (iso: string | null | undefined): boolean => {
    if (!iso) return true;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return true;
    return (startMs == null || t >= startMs) && (endMs == null || t <= endMs);
  };

  const tl = await serviceTimelineStore.get(serviceKey);
  if (tl) {
    if (opts.startedAt) tl.startedAt = opts.startedAt;
    if (opts.endedAt) tl.endedAt = opts.endedAt;
    if (endMs != null) {
      tl.items = tl.items.filter((it) => Date.parse(it.startedAt) <= endMs); // drop items starting after the end
      for (const it of tl.items) {
        if (it.endedAt == null || Date.parse(it.endedAt) > endMs) {
          it.endedAt = new Date(endMs).toISOString();
          const s = Date.parse(it.startedAt);
          if (Number.isFinite(s)) it.actualDurationSec = Math.max(0, Math.round((endMs - s) / 1000));
        }
      }
    }
    await serviceTimelineStore.upsert(tl);
    broadcast("service-timeline:history", tl);
  }

  const att = await attendanceStore.get(serviceKey);
  if (att) {
    if (opts.startedAt) att.startedAt = opts.startedAt;
    if (opts.endedAt) att.endedAt = opts.endedAt;
    att.samples = att.samples.filter((s) => inWindow(s.t));
    recomputeAttendance(att);
    await attendanceStore.upsert(att);
    broadcast("attendance:history", att);
  }

  const spl = await splHistoryStore.get(serviceKey);
  if (spl) {
    if (opts.startedAt) spl.startedAt = opts.startedAt;
    if (opts.endedAt) {
      spl.endedAt = opts.endedAt;
      spl.items = spl.items.filter((it) => (endMs == null ? true : Date.parse(it.startedAt) <= endMs));
    }
    await splHistoryStore.upsert(spl);
    broadcast("spl:history", spl);
  }
}

/** Set a per-item override for whether it counts toward the service timers (wins
 *  over the auto buffer/pre-service default). */
export async function setItemCounted(serviceKey: string, itemId: string, counted: boolean): Promise<void> {
  const tl = await serviceTimelineStore.get(serviceKey);
  if (!tl) return;
  const it = tl.items.find((x) => x.itemId === itemId);
  if (!it) return;
  it.counted = counted;
  await serviceTimelineStore.upsert(tl);
  broadcast("service-timeline:history", tl);
}

/** Re-derive attendance aggregates from the current samples (no window change) —
 *  for when the stored peak/min look stale but the samples are fine. */
export async function recalcAttendance(serviceKey: string): Promise<void> {
  const att = await attendanceStore.get(serviceKey);
  if (!att) return;
  recomputeAttendance(att);
  await attendanceStore.upsert(att);
  broadcast("attendance:history", att);
}
