/** The Overview's scope filters, split because the trend and the average want
 *  different answers about the service that is recording right now.
 *
 *  The trend SHOWS it — that is the point: the dot climbs through the morning.
 *  The average EXCLUDES it — a peak that is still climbing would drag a
 *  cross-service mean down and read as a broken number until about noon. Once
 *  the service ends, endedAt is stamped and it becomes an ordinary point in both. */
type Scoped = { endedAt?: string | null; serviceTypeId: string | null; serviceDate: string };
/** A record with a lifecycle. Only the AVERAGE needs one — see above — so this
 *  is where `endedAt` becomes required, and the SPL summary (written once, after
 *  the service is over, with no endedAt of its own) can be scoped by the trend
 *  filter without being given a fake one. */
type Settled = Scoped & { endedAt: string | null };

function matchesFilters(r: Scoped, activeType: string | null, asOf: string | null): boolean {
  return (!activeType || r.serviceTypeId === activeType) && (!asOf || r.serviceDate <= asOf);
}

export function inTrendScope(r: Scoped, activeType: string | null, asOf: string | null): boolean {
  return matchesFilters(r, activeType, asOf);
}

export function inAverageScope(r: Settled, activeType: string | null, asOf: string | null): boolean {
  return r.endedAt != null && matchesFilters(r, activeType, asOf);
}
