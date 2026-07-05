import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live SenSource Vea people counts, pushed on the "people:count" channel.
 * Hydrates once on mount (the channel only broadcasts on poll) then stays live.
 * Shared by the custom-layout "People counter" object and its editor inspector.
 */
export function usePeopleCountState(): PeopleCountDTO | null {
  const [people, setPeople] = useState<PeopleCountDTO | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<PeopleCountDTO>("people:getCount")
      .then((s) => {
        if (!cancelled && s) setPeople(s);
      })
      .catch(() => {
        /* not configured yet — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onNotification("people:count", (p) => setPeople(p as PeopleCountDTO));
  }, []);

  return people;
}

/** Mean peak in-room across finished recorded services (the "average service"),
 *  from Attendance history. Fetched only when `enabled`; refreshes on mount.
 *  Returns null until loaded / when there are no completed services. */
export function useServiceAvgOccupancy(enabled: boolean): number | null {
  const [avg, setAvg] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<ServiceAttendance[]>("attendance:listHistory")
      .then((list) => {
        if (cancelled) return;
        const finished = (list ?? []).filter((s) => s.endedAt != null && s.peakOccupancy > 0);
        if (!finished.length) return setAvg(null);
        const mean = finished.reduce((a, s) => a + s.peakOccupancy, 0) / finished.length;
        setAvg(Math.round(mean));
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return avg;
}

/** Lowest in-room occupancy during the current (or most recent) live service —
 *  the service "floor". Mirrors the in-progress attendance record: hydrates from
 *  `attendance:getHistoryCurrent` on mount, then stays live on the
 *  "attendance:history" channel (the recorder broadcasts the open record each
 *  tick). Returns null when nothing has been recorded yet. Fetched only when
 *  `enabled`. Note: 0 is a real value (the room emptied mid-service), so it's
 *  preserved — only null/undefined map to "no data". */
export function useLiveServiceLow(enabled: boolean): number | null {
  const [low, setLow] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<ServiceAttendance | null>("attendance:getHistoryCurrent")
      .then((rec) => {
        if (!cancelled) setLow(rec?.minOccupancy ?? null);
      })
      .catch(() => {
        /* ignore */
      });
    const off = onNotification("attendance:history", (p) => {
      const rec = p as ServiceAttendance | null;
      setLow(rec?.minOccupancy ?? null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);
  return low;
}

/** Per-service attendance for the current (or most-recent) live service — the count
 *  entered THIS service, baselined by the recorder so a second service in the same
 *  plan starts from 0 (vs. the day-total `attendance` metric). From the in-progress
 *  attendance record's per-service `lastAttendance`. null when nothing's recording. */
export function useLiveServiceAttendance(enabled: boolean): number | null {
  const [val, setVal] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<ServiceAttendance | null>("attendance:getHistoryCurrent")
      .then((rec) => {
        if (!cancelled) setVal(rec?.lastAttendance ?? null);
      })
      .catch(() => {
        /* ignore */
      });
    const off = onNotification("attendance:history", (p) => {
      const rec = p as ServiceAttendance | null;
      setVal(rec?.lastAttendance ?? null);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);
  return val;
}

export type PeopleMetric = "attendance" | "serviceAttendance" | "occupancy" | "peak" | "min" | "avg";

/** Resolve the value an object should show, by metric + optional zone. Returns
 *  null when there's no data (so the renderer can show a placeholder).
 *  peak/min/avg are today's building-wide values (from the space endpoint) and
 *  have no per-zone series, so a zone-scoped peak/min/avg resolves to null. */
export function resolvePeopleValue(
  people: PeopleCountDTO | null,
  metric: PeopleMetric,
  zoneId: string | null | undefined,
): number | null {
  if (!people) return null;
  // Per-service attendance isn't a live building-count field — it comes from the
  // in-progress record (ctx.serviceAttendance) and is special-cased at the call site.
  if (metric === "serviceAttendance") return null;
  if (zoneId) {
    if (metric === "attendance" || metric === "occupancy") {
      const z = people.zones.find((zone) => zone.id === zoneId);
      return z ? z[metric] : null;
    }
    return null;
  }
  return people.total[metric] ?? null;
}
