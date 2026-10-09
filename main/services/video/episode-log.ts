// main/services/video/episode-log.ts — what the `[video]` struggling and
// lagging lines last announced, per (output, feed) pair.
//
// Both flags are logged the same way: a line when an episode starts, another
// when it ends, nothing while it holds. The episode's id — not whether the
// flag reads on — is what is compared, because one record() call can clear a
// flag in its sweep and re-arm it from the same heartbeat's own report: the
// flag reads on both before and after, and only a changed id says a clear and
// a new episode happened in between (see playback-health.ts's Sticky).

export class EpisodeLog {
  /** pair key -> the episode id the last line announced as on; null or absent
   *  when the last word was "ended", or nothing yet. */
  private readonly announced = new Map<string, number | null>();

  /**
   * Says what changed since this pair was last noted: `ended` when an
   * announced episode is over (including one replaced by a new id), then
   * `started` for the one now holding. `current` is the pair's episode id, or
   * null when its flag is off.
   */
  note(key: string, current: number | null, say: { started: () => void; ended: () => void }): void {
    const last = this.announced.get(key) ?? null;
    if (current !== last) {
      if (last !== null) say.ended();
      if (current !== null) say.started();
    }
    this.announced.set(key, current);
  }

  /** Forgets every pair not in `live`. Without this, a pair that left while
   *  on and comes back later would log nothing on its first genuine episode (a
   *  stale id reads as "already announced") or a spurious "ended" for one
   *  nothing announced. */
  prune(live: ReadonlySet<string>): void {
    for (const key of this.announced.keys()) {
      if (!live.has(key)) this.announced.delete(key);
    }
  }

  /** Forgets every pair naming `feedId` (keys are playback-health.ts's
   *  pairKey(): outputId, NUL, feedId) — a removed feed re-added under the
   *  same name must not read as already announced. */
  forgetFeed(feedId: string): void {
    for (const key of this.announced.keys()) {
      if (key.endsWith(`\u0000${feedId}`)) this.announced.delete(key);
    }
  }

  /** Exposed for tests. */
  has(key: string): boolean {
    return this.announced.has(key);
  }
}
