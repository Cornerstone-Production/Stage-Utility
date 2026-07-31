import type { BaptismSession, ServiceTimeline } from "@main/types/stage.js";

/**
 * Which baptism sessions belong to a service.
 *
 * Sessions recorded since the timer began stamping `serviceKey` say which
 * occurrence they belong to, so they are matched exactly. Everything older is
 * matched the only way it can be — by overlapping the service's window — which has
 * two failure modes worth knowing about, and is why the key exists:
 *
 *   - one session left running across two services overlaps both, and counts twice
 *   - a service that never finished has no end, so a window has to be assumed; a
 *     later service's baptisms can fall inside it
 *
 * The fallback is deliberately narrow: it only applies to sessions with no key at
 * all. A keyed session that does not match is NOT then considered by time, or a
 * baptism from the 9am would reappear on the 11am whenever the two ran long.
 */

/** How long a service is assumed to run when it never recorded an end. */
const ASSUMED_LENGTH_MS = 6 * 60 * 60 * 1000;

export function linkBaptisms(all: readonly BaptismSession[], tl: ServiceTimeline): BaptismSession[] {
  const keyed = all.filter((b) => b.serviceKey);
  const exact = keyed.filter((b) => b.serviceKey === tl.serviceKey);

  const start = Date.parse(tl.startedAt);
  const end = tl.endedAt ? Date.parse(tl.endedAt) : start + ASSUMED_LENGTH_MS;
  const overlapping = all.filter((b) => {
    if (b.serviceKey) return false; // keyed sessions are matched exactly, or not at all
    const bs = Date.parse(b.startedAt);
    const be = Date.parse(b.finishedAt);
    return Number.isFinite(bs) && Number.isFinite(be) && bs <= end && be >= start;
  });

  return [...exact, ...overlapping];
}

/** People and total timed seconds across a set of sessions. */
export function baptismTotals(sessions: readonly BaptismSession[]): { people: number; sec: number } {
  const people = sessions.reduce((a, b) => a + b.people.length, 0);
  const ms = sessions.reduce((a, b) => a + b.people.reduce((x, p) => x + p.testimonyMs + p.baptizeMs, 0), 0);
  return { people, sec: ms / 1000 };
}
