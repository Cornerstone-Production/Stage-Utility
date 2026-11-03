// When this browser first saw each integration down.
//
// IntegrationState carries no timestamp, and "down for more than 30 s" needs
// one. This is a fold: ids newly down are stamped, ids still down keep their
// stamp, ids that came back are forgotten -- so a second outage starts a fresh
// thirty seconds rather than inheriting the first's.

export function trackDownSince(
  previous: ReadonlyMap<string, number>,
  downIds: readonly string[],
  now: number,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const id of downIds) next.set(id, previous.get(id) ?? now);
  const same = next.size === previous.size && [...next].every(([id, at]) => previous.get(id) === at);
  return same ? previous : next;
}
