// main/services/video/playback-health.ts — a rolling one-minute window of
// each (output, feed) pair's playback deltas, and whether that pair is
// struggling.
//
// video-service.ts is the one caller: recordPlaybackReports() there parses a
// presence heartbeat's `video` field with parseVideoReports() below, drops
// any feed id this build no longer holds, then hands the rest to record().
// snapshot() is folded into VideoState.screens on every publish.

import type { ScreenVideoHealth, VideoPlaybackReport } from "../../types/video.js";

/** How far back a pair's samples are summed for the fraction/stall checks
 *  below, and how long a stale pair is still carried in `snapshot()` before
 *  it is read as gone rather than merely quiet. */
export const WINDOW_MS = 60_000;
/** `dropped / decoded` strictly ABOVE this is struggling — 51 dropped of
 *  1000 decoded (5.1%) is; 50 (exactly 5%) is not. See isBadWindow()'s own
 *  comment for why this is `>`, not `>=`. */
export const DROPPED_FRACTION = 0.05;
/** This many stalls or more within the window is struggling on its own,
 *  whatever the dropped fraction says. */
export const STALLS_IN_WINDOW = 3;
/** How long `struggling` stays true after the last sample that kept the
 *  window's own fraction/stall check bad — see the sticky-flag comment on
 *  `Pair.lastBadAt` for why this is a separate constant from WINDOW_MS
 *  rather than the same read twice. Currently equal in value; the two mean
 *  different things and are named separately on purpose. */
export const CLEAR_AFTER_MS = 60_000;

/** A heartbeat's own cap — see parseVideoReports(). A screen reports one
 *  entry per currently-playing widget instance, so this is generous for any
 *  real layout while still refusing a body trying to make the server hold an
 *  unbounded array. */
export const MAX_REPORTS = 32;

/** Samples held per pair, capped — see the merge branch in record(). A LAN
 *  client posting a valid outputId and feed id in a tight loop would
 *  otherwise grow one pair's own array for a full WINDOW_MS, and every
 *  record() call for it is linear in that array's length. 30 is generous for
 *  the real cadence (one heartbeat per ~10 s, so a full 60 s window holds
 *  about 6 in practice) while still bounding a hostile burst. */
export const MAX_SAMPLES_PER_PAIR = 30;

/** One report's deltas, timestamped — never a running total, the same way
 *  VideoPlaybackReport itself never is. */
interface Sample {
  at: number;
  decoded: number;
  dropped: number;
  stalls: number;
}

interface Pair {
  via: "webrtc" | "hls";
  width: number;
  height: number;
  /** This pair's last report — see ScreenVideoHealth's own comment. */
  reportedAt: number;
  /** Pruned to WINDOW_MS on every touch (record()/snapshot()). */
  samples: Sample[];
  /**
   * The last time the WINDOWED fraction/stall check (isBadWindow(), below)
   * evaluated true for this pair — null if it never has. `struggling` is
   * read off THIS, not off a fresh isBadWindow() call: a clean report
   * arriving while a bad one is still inside the window adds its own
   * (large) decoded count to the sum, which would otherwise DILUTE the
   * fraction back under threshold long before the bad sample itself ages
   * out — clearing the flag on a technicality rather than on 60 clean
   * seconds. Recording `lastBadAt` and comparing it to `now` directly is
   * what makes "a clean report 30 s later keeps it struggling; clean
   * reports until 60 s after the last bad sample clear it" true regardless
   * of how much clean traffic arrives in between.
   */
  lastBadAt: number | null;
  /**
   * `isStrugglingAt(lastBadAt, at)` as record() last computed it — read back
   * as THIS call's `wasStruggling`, never re-derived fresh against the new
   * `now`. The sticky flag clears purely from elapsed wall-clock time, with
   * no call landing at the exact moment it happens; the first call to
   * notice is whichever one happens next, however much later that is. If
   * that call compared a FRESH recompute of the old state (using the OLD
   * `lastBadAt` but the NEW `now`) against a fresh recompute of the new
   * state, both would already read past the clear boundary by the time
   * either runs — matching each other and reporting no flip at all, so
   * neither `changed` nor the "smoothly again" log line would ever fire.
   * Comparing against what THIS field held after the PREVIOUS call — a
   * plain stored fact, immune to how much time has passed since — is what
   * makes the transition visible to whichever call finally notices it.
   */
  struggling: boolean;
}

interface Totals {
  decoded: number;
  dropped: number;
  stalls: number;
}

function sumSamples(samples: readonly Sample[]): Totals {
  let decoded = 0, dropped = 0, stalls = 0;
  for (const s of samples) {
    decoded += s.decoded;
    dropped += s.dropped;
    stalls += s.stalls;
  }
  return { decoded, dropped, stalls };
}

/**
 * Whether this window's own totals are bad enough to (re)arm the sticky
 * flag — never read directly as `struggling` itself; see `Pair.lastBadAt`.
 *
 * `>`, not `>=`: 50 dropped of 1000 decoded is exactly 5% and must read as
 * NOT struggling; 51 is 5.1% and must. Flip this to `>=` and the "50
 * dropped: not struggling" case goes red — that is the guard's own proof.
 */
function isBadWindow(totals: Totals): boolean {
  if (totals.stalls >= STALLS_IN_WINDOW) return true;
  if (totals.decoded === 0) return totals.dropped > 0;
  return totals.dropped / totals.decoded > DROPPED_FRACTION;
}

/** Whether the sticky flag reads true AT `at`, given the pair's own
 *  `lastBadAt` — the one place both record() and snapshot() do this check,
 *  so the two can never drift on what "struggling" means. */
function isStrugglingAt(lastBadAt: number | null, at: number): boolean {
  return lastBadAt !== null && at - lastBadAt < CLEAR_AFTER_MS;
}

/** A `snapshot()` entry's own (outputId, feedId) identity, as a Map key —
 *  video-service.ts uses this to diff a before/after snapshot pair and log
 *  the flip. Exported rather than reimplemented there so the two files
 *  cannot disagree on what identifies a pair. */
export function pairKey(outputId: string, feedId: string): string {
  return `${outputId}\u0000${feedId}`;
}

export class PlaybackHealth {
  /** outputId -> feedId -> that pair's state. A composite string key over
   *  two Maps rather than one flat `Map<string, Pair>` keyed on
   *  `pairKey()` would also satisfy "never a plain object", but nesting by
   *  outputId is what lets a screen's own pairs be pruned and read without
   *  scanning every OTHER screen's entries too. Both outputId and feedId
   *  arrive on an unauthenticated LAN POST — a plain object keyed by either
   *  is exactly the request-keyed-property-injection shape this repo fixes
   *  with Maps. */
  private readonly pairs = new Map<string, Map<string, Pair>>();

  private pruneSamples(samples: readonly Sample[], now: number): Sample[] {
    return samples.filter((s) => now - s.at < WINDOW_MS);
  }

  /**
   * Ages out every pair (any output, not only the one reporting) whose last
   * report is WINDOW_MS or older. Run at the start of every record() call —
   * presence heartbeats arrive roughly every 10 s from any screen currently
   * playing something (see VideoPlaybackReport's own comment), so in a
   * building with more than one screen live this doubles as the sweep that
   * notices ANOTHER screen going quiet, not only the one that just called
   * in. A lone screen that stops reporting entirely is still caught the
   * next time anything reads `snapshot()` — its own defensive age check
   * does not depend on this sweep having run.
   *
   * @returns whether anything was actually removed — folded into record()'s
   *   own `changed` result as "a pair left".
   */
  private sweepStale(now: number): boolean {
    let removedAny = false;
    for (const [outputId, byFeed] of this.pairs) {
      for (const [feedId, pair] of byFeed) {
        if (now - pair.reportedAt >= WINDOW_MS) {
          byFeed.delete(feedId);
          removedAny = true;
        }
      }
      if (byFeed.size === 0) this.pairs.delete(outputId);
    }
    return removedAny;
  }

  /**
   * Records one heartbeat's reports for one screen. `reports` must already
   * be refusal-checked (parseVideoReports) and filtered to feed ids this
   * server currently holds — record() trusts both, the same contract
   * markRequested() documents in video-service.ts for its own caller.
   *
   * @returns whether `snapshot()` would now read differently: a struggling
   *   flag flipped, a pair appeared, a pair left (aged out, this call or a
   *   previous one this call's sweep just noticed), or a currently-
   *   struggling pair's window totals moved. video-service.ts publishes
   *   only then — never on every heartbeat from a screen playing cleanly.
   */
  record(outputId: string, reports: readonly VideoPlaybackReport[], now: number): boolean {
    let changed = this.sweepStale(now);
    if (reports.length === 0) return changed;

    const byFeed = this.pairs.get(outputId) ?? new Map<string, Pair>();
    if (!this.pairs.has(outputId)) this.pairs.set(outputId, byFeed);

    // Two widgets on the same screen can report the same feed id — folded
    // together here so a pair stays one entry regardless of how many
    // widgets on this screen are showing it. Order within the heartbeat
    // decides which report's via/width/height wins for a shared feed; there
    // is no single "right" answer when two widgets genuinely differ; both
    // report the same decoder's own frame size in every real case.
    const merged = new Map<string, { via: "webrtc" | "hls"; width: number; height: number; decoded: number; dropped: number; stalls: number }>();
    for (const r of reports) {
      const acc = merged.get(r.feedId);
      if (acc) {
        acc.decoded += r.decoded;
        acc.dropped += r.dropped;
        acc.stalls += r.stalls;
        acc.via = r.via;
        acc.width = r.width;
        acc.height = r.height;
      } else {
        merged.set(r.feedId, { via: r.via, width: r.width, height: r.height, decoded: r.decoded, dropped: r.dropped, stalls: r.stalls });
      }
    }

    for (const [feedId, r] of merged) {
      const existing = byFeed.get(feedId);
      const wasStruggling = existing?.struggling ?? false;

      const samples = this.pruneSamples(existing?.samples ?? [], now);
      // At the cap, merge into the newest held sample rather than growing
      // further — see MAX_SAMPLES_PER_PAIR's own comment. Summing the counts
      // keeps sumSamples() exact; the merged entry's own `at` becomes `now`,
      // which is what "the newest" means for a future prune.
      if (samples.length >= MAX_SAMPLES_PER_PAIR) {
        const newest = samples[samples.length - 1]!;
        samples[samples.length - 1] = {
          at: now,
          decoded: newest.decoded + r.decoded,
          dropped: newest.dropped + r.dropped,
          stalls: newest.stalls + r.stalls,
        };
      } else {
        samples.push({ at: now, decoded: r.decoded, dropped: r.dropped, stalls: r.stalls });
      }
      const totals = sumSamples(samples);
      // Re-arm only when THIS sample itself is bad — not merely when the
      // cumulative window still reads bad, which a clean sample can do for
      // as long as an OLDER bad one is still inside it. Without the
      // `sampleIsBad` half, a single stall (or dropped frame) at t0 followed
      // by clean heartbeats every 10 s keeps re-arming on EVERY one of them
      // for as long as isBadWindow() stays true from the original sample
      // alone — pushing the clear boundary out well past 60 s after the
      // actual last bad sample, exactly the "clears 80 s after the last
      // dropping sample" bug this guards.
      const sampleIsBad = r.dropped > 0 || r.stalls > 0;
      const lastBadAt = sampleIsBad && isBadWindow(totals) ? now : (existing?.lastBadAt ?? null);
      const isStruggling = isStrugglingAt(lastBadAt, now);

      byFeed.set(feedId, { via: r.via, width: r.width, height: r.height, reportedAt: now, samples, lastBadAt, struggling: isStruggling });

      if (!existing) {
        changed = true; // a pair appeared
      } else if (wasStruggling !== isStruggling) {
        changed = true; // the sticky flag flipped
      } else if (isStruggling) {
        const before = sumSamples(this.pruneSamples(existing.samples, now));
        if (before.decoded !== totals.decoded || before.dropped !== totals.dropped || before.stalls !== totals.stalls) {
          changed = true; // a struggling pair's totals moved
        }
      }
    }
    return changed;
  }

  /**
   * Removes every pair naming `feedId`, whichever output reported it —
   * video-service.ts's removeFeed() calls this alongside its own cleanup of
   * lastPaths/bframesMarks/lastLoggedState/etc. for the same feed id. Without
   * it, a feed deleted while struggling and then RE-ADDED under the same
   * name (feedIdFor() is deterministic from the name, so this is not a rare
   * shape) would read as struggling again for up to WINDOW_MS on a build
   * that has never actually measured the new feed's playback at all — the
   * old feed's history, not its own, the same failure mode the other
   * per-feed maps are already cleared for.
   */
  forgetFeed(feedId: string): void {
    for (const [outputId, byFeed] of this.pairs) {
      byFeed.delete(feedId);
      if (byFeed.size === 0) this.pairs.delete(outputId);
    }
  }

  /** Every currently-live pair's health, freshest first play order not
   *  guaranteed — video-service.ts and the Screens page both filter/group
   *  by outputId or feedId themselves. A pair whose last report is
   *  WINDOW_MS old or older is left out even if record() has not run since
   *  (and so never swept it out of the underlying map) — this is the
   *  correctness backstop sweepStale() does not have to be relied on for. */
  snapshot(now: number): ScreenVideoHealth[] {
    const out: ScreenVideoHealth[] = [];
    for (const [outputId, byFeed] of this.pairs) {
      for (const [feedId, pair] of byFeed) {
        if (now - pair.reportedAt >= WINDOW_MS) continue;
        const totals = sumSamples(this.pruneSamples(pair.samples, now));
        const struggling = isStrugglingAt(pair.lastBadAt, now);
        out.push({
          outputId,
          feedId,
          via: pair.via,
          struggling,
          droppedInWindow: totals.dropped,
          decodedInWindow: totals.decoded,
          stallsInWindow: totals.stalls,
          width: pair.width,
          height: pair.height,
          reportedAt: pair.reportedAt,
        });
      }
    }
    return out;
  }
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * `body.video`'s refusal rules: a non-array, more than MAX_REPORTS entries,
 * or any single entry with a non-string/empty `feedId`, a `via` other than
 * "webrtc"/"hls", or any of decoded/dropped/stalls/width/height not a
 * finite non-negative integer refuses the WHOLE array — `null`, never a
 * partial one. A malformed screen must not be able to poison one pair's
 * numbers while its others look normal, and the caller reads `null` the
 * same way it reads "no `video` field at all": nothing to record this
 * heartbeat. The heartbeat's PRESENCE half (displayHeartbeat) is untouched
 * either way — refusing `video` is not refusing that the screen is alive.
 */
export function parseVideoReports(body: unknown): VideoPlaybackReport[] | null {
  if (!Array.isArray(body) || body.length > MAX_REPORTS) return null;
  const out: VideoPlaybackReport[] = [];
  for (const item of body) {
    if (typeof item !== "object" || item === null) return null;
    const r = item as Record<string, unknown>;
    if (typeof r.feedId !== "string" || r.feedId.length === 0) return null;
    if (r.via !== "webrtc" && r.via !== "hls") return null;
    if (![r.decoded, r.dropped, r.stalls, r.width, r.height].every(isNonNegativeInteger)) return null;
    out.push({
      feedId: r.feedId,
      via: r.via,
      decoded: r.decoded as number,
      dropped: r.dropped as number,
      stalls: r.stalls as number,
      width: r.width as number,
      height: r.height as number,
    });
  }
  return out;
}
