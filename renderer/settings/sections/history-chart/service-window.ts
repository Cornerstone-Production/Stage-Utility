// service-window.ts — when the service proper began and ended.
//
// ONE answer, shared by both charts. They had two: attendance used its own
// record's `serviceStartedAt`, and sound passed the SPL recording's start — but
// SPL recording starts at the first plan item, which is usually "Doors", so the
// window began where the chart began and the hatch never drew at all. The two
// charts sit one above the other on the same page with the same x scale; a band
// on one and not the other reads as a difference in the data.
//
// The timeline is the authority when there is one: the service proper starts at
// the first item that is not pre-service, which is what the operator marked. The
// attendance record's own `serviceStartedAt` is the fallback, because a service
// whose timeline has not opened yet still has an attendance curve to hatch.

/** Both records as much of them as this needs — narrow, so a caller with only
 *  one of the two does not have to invent the other. */
export interface ServiceWindowSources {
  timeline?: { endedAt?: string | null; items?: { startedAt: string; endedAt: string | null; preService?: boolean }[] } | null;
  attendance?: { serviceStartedAt?: string | null; endedAt?: string | null } | null;
}

export interface ServiceWindow {
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * The band between the arrival ramp and the taper.
 *
 * Either end may be null — a service still in its ramp has no start yet, and a
 * live one has no end. The chart hatches only the ends it is given, so a null is
 * "not known", never "no ramp".
 */
export function serviceWindowOf({ timeline, attendance }: ServiceWindowSources): ServiceWindow {
  const items = timeline?.items ?? [];
  const firstInService = items.find((it) => !it.preService && it.startedAt);
  const startedAt = firstInService?.startedAt ?? attendance?.serviceStartedAt ?? null;

  // The END is the attendance record's, when there is one: it is the taper
  // boundary the recorder wrote, and the post-service samples run past it. With
  // no attendance end, the last item to have ENDED stands in, but only once no
  // in-service item is still running. While one is, the service has no end yet:
  // the last ENDED item is the one before the live one, and taking it hatched
  // the live item, the message mid-service, as "after the service". A record
  // that has closed is not live, whatever item it left open: its last ended
  // item still marks the taper.
  const stillLive = !timeline?.endedAt && items.some((it) => !it.preService && it.startedAt && !it.endedAt);
  const lastEnded = stillLive ? null : items.reduce<string | null>(
    (best, it) => (it.endedAt && (!best || it.endedAt > best) ? it.endedAt : best),
    null,
  );
  const endedAt = attendance?.endedAt ?? lastEnded ?? null;

  // A window that runs backwards is not a window. It happens when a timeline's
  // only in-service item starts after the attendance record has closed — a
  // mis-stamped record, or a merge that went wrong — and drawing it paints the
  // whole plot as "after the service".
  if (startedAt && endedAt && Date.parse(endedAt) <= Date.parse(startedAt)) {
    return { startedAt, endedAt: null };
  }
  return { startedAt, endedAt };
}
