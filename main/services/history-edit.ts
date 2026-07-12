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
  // Per-service attendance = value − first sample (the count when this window began),
  // so a service not reset off the prior one reads its own count; on a trim, the new
  // first in-window sample re-baselines automatically.
  const base = s.length ? s[0].attendance : 0;
  const perSvc = (v: number) => Math.max(0, v - base);
  att.attendanceBaseline = base;
  att.peakAttendance = s.reduce((m, x) => Math.max(m, perSvc(x.attendance)), 0);
  att.peakOccupancy = s.reduce((m, x) => Math.max(m, x.occupancy), 0);
  att.minOccupancy = s.length ? s.reduce((m, x) => Math.min(m, x.occupancy), s[0].occupancy) : null;
  att.lastAttendance = s.length ? perSvc(s[s.length - 1].attendance) : 0;
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

/**
 * Merge one service recording (source) INTO another (target) across all three
 * stores, then delete the source. Fixes a mis-split service (e.g. a run that
 * overran its planned end and rolled the tail into the next occurrence's record):
 * merge the wrong record back into the right one. Items are matched by itemId so a
 * duplicated boundary item isn't doubled; attendance samples are concatenated and
 * aggregates re-derived; the target window extends to cover both.
 */
export async function mergeServiceRecords(sourceKey: string, targetKey: string): Promise<void> {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;

  // ── Timeline ──
  const [srcTl, tgtTl] = await Promise.all([
    serviceTimelineStore.get(sourceKey),
    serviceTimelineStore.get(targetKey),
  ]);
  if (srcTl && tgtTl) {
    const have = new Set(tgtTl.items.map((i) => i.itemId));
    for (const it of srcTl.items) if (!have.has(it.itemId)) tgtTl.items.push(it);
    tgtTl.items.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    tgtTl.items.forEach((it, i) => { it.sequence = i; });
    const ends = tgtTl.items.map((i) => (i.endedAt ? Date.parse(i.endedAt) : NaN)).filter(Number.isFinite);
    if (ends.length) tgtTl.endedAt = new Date(Math.max(...ends)).toISOString();
    await serviceTimelineStore.upsert(tgtTl);
    await serviceTimelineStore.delete(sourceKey);
    broadcast("service-timeline:history", tgtTl);
  }

  // ── Attendance ──
  const [srcAt, tgtAt] = await Promise.all([
    attendanceStore.get(sourceKey),
    attendanceStore.get(targetKey),
  ]);
  if (srcAt && tgtAt) {
    tgtAt.samples = [...tgtAt.samples, ...srcAt.samples].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    if (srcAt.endedAt && (!tgtAt.endedAt || Date.parse(srcAt.endedAt) > Date.parse(tgtAt.endedAt))) {
      tgtAt.endedAt = srcAt.endedAt;
    }
    tgtAt.totalAttendance = Math.max(tgtAt.totalAttendance, srcAt.totalAttendance);
    recomputeAttendance(tgtAt);
    await attendanceStore.upsert(tgtAt);
    await attendanceStore.delete(sourceKey);
    broadcast("attendance:history", tgtAt);
  }

  // ── SPL ──
  const [srcSpl, tgtSpl] = await Promise.all([
    splHistoryStore.get(sourceKey),
    splHistoryStore.get(targetKey),
  ]);
  if (srcSpl && tgtSpl) {
    const have = new Set(tgtSpl.items.map((i) => i.itemId));
    for (const it of srcSpl.items) if (!have.has(it.itemId)) tgtSpl.items.push(it);
    tgtSpl.items.forEach((it, i) => { it.sequence = i; });
    if (srcSpl.endedAt && (!tgtSpl.endedAt || Date.parse(srcSpl.endedAt) > Date.parse(tgtSpl.endedAt))) {
      tgtSpl.endedAt = srcSpl.endedAt;
    }
    await splHistoryStore.upsert(tgtSpl);
    await splHistoryStore.delete(sourceKey);
    broadcast("spl:history", tgtSpl);
  }
}
