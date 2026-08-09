// pick-service-time.ts — which of a plan's service times is the relevant one?
//
// The answer feeds the pre-service countdown AND the `serviceTimeId` in every
// recorder's key, so getting it wrong does not just mis-target a clock: it files
// one service's recording under another's.
//
// PCO sets `ends_at` only when a plan time was given a length, and plenty are
// entered without one. The original test treated a missing end as "still
// upcoming", which never went false — so with two end-less times the ascending
// sort returned the earlier one all day, and the 11am service was recorded into
// the 9am's record.
//
// With no end time there is no direct signal that a service is over. There is an
// indirect one: a later service has begun. An end-less time is therefore finished
// once any later-starting time has started. Where ends_at IS set it is used as
// before and stays more precise — the gap between one service ending and the next
// beginning belongs to the next.

/** Just the fields this decision needs. */
export interface PickableTime {
  startsAt: string;
  endsAt?: string | null;
}

export function pickServiceTime<T extends PickableTime>(services: T[], nowMs: number = Date.now()): T | null {
  const startOf = (t: T): number => Date.parse(t.startsAt);

  const finished = (t: T): boolean => {
    if (t.endsAt) {
      const end = Date.parse(t.endsAt);
      if (Number.isFinite(end)) return end <= nowMs;
    }
    const start = startOf(t);
    // An unparseable start is not evidence the service is over. Fail open: a
    // stray time must never be able to rule out a service that is happening.
    if (!Number.isFinite(start)) return false;
    return services.some((o) => o !== t && startOf(o) > start && startOf(o) <= nowMs);
  };

  const upcoming = services.filter((t) => !finished(t)).sort((a, b) => startOf(a) - startOf(b))[0];
  // Everything is over — the last one is the service that just happened, which is
  // what the taper and the history record still belong to.
  return upcoming ?? services.slice().sort((a, b) => startOf(b) - startOf(a))[0] ?? null;
}
