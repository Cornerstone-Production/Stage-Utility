// How long the segment currently being timed has run.
//
// A segment used to be a single `segmentStartedAt` timestamp and nothing else, so
// elapsed was just `now - start`. That cannot express a pause, and a pause is
// needed: between a testimony and the next person stepping up there is talking, and
// between the testimonies and the baptisms themselves there is often several
// minutes of vows, prayer and preaching. Without one, all of it lands on whichever
// person happens to be timing.
//
// So a segment is now "time already banked, plus time since it last resumed":
//
//   accum = 0,   startedAt = t0      → running
//   accum = 90s, startedAt = null    → paused, 90s banked
//   accum = 90s, startedAt = t1      → resumed, counting on from 90s
//
// Both the server and the display compute from the same two fields, so a paused
// clock reads the same everywhere without anything having to be pushed.

export interface Segment {
  /** Milliseconds banked by earlier runs of this segment. */
  segmentAccumMs?: number;
  /** When the current run began, or null while paused. */
  segmentStartedAt?: string | null;
}

/** Elapsed milliseconds for a segment, paused or running. */
export function segmentElapsedMs(seg: Segment, now = Date.now()): number {
  const banked = Math.max(0, seg.segmentAccumMs ?? 0);
  if (!seg.segmentStartedAt) return banked;
  const started = Date.parse(seg.segmentStartedAt);
  if (!Number.isFinite(started)) return banked;
  return banked + Math.max(0, now - started);
}

/** True when the segment exists but is not currently counting. */
export function isPaused(seg: Segment, phase: string): boolean {
  return phase !== "idle" && !seg.segmentStartedAt;
}
