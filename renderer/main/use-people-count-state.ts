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

/** Resolve the value an object should show, by metric + optional zone. Returns
 *  null when there's no data (so the renderer can show a placeholder). */
export function resolvePeopleValue(
  people: PeopleCountDTO | null,
  metric: "attendance" | "occupancy",
  zoneId: string | null | undefined,
): number | null {
  if (!people) return null;
  if (zoneId) {
    const z = people.zones.find((zone) => zone.id === zoneId);
    return z ? z[metric] : null;
  }
  return people.total[metric];
}
