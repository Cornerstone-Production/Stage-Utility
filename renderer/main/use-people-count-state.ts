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

export type PeopleMetric = "attendance" | "occupancy" | "peak" | "min" | "avg";

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
  if (zoneId) {
    if (metric === "attendance" || metric === "occupancy") {
      const z = people.zones.find((zone) => zone.id === zoneId);
      return z ? z[metric] : null;
    }
    return null;
  }
  return people.total[metric] ?? null;
}
