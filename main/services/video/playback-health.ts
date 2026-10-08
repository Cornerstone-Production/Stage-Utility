// main/services/video/playback-health.ts — a rolling one-minute window of
// each (output, feed) pair's playback deltas, and whether that pair is
// struggling or lagging. Struggling is about dropped frames and stalls;
// lagging is about delay the screen's own browser is holding (the WebRTC
// receive-delay figures a report may carry) — separate flags, so a pair can
// be either, both or neither.
//
// video-service.ts is the one caller: recordPlaybackReports() there parses a
// presence heartbeat's `video` field with parseVideoReports() below, drops
// any feed id this build no longer holds, then hands the rest to record().
// snapshot() is read into a CACHED VideoState.screens exactly when record()
// (or the one-shot expiry timer, over tick()) says something changed — never
// on every publish, which used to make the relay's own 3 s status poll a
// video:state broadcast on almost every heartbeat (`reportedAt` and the
// window totals move every heartbeat and as samples age out, and the plain
// diff every publish() already does saw that as a real change).

import type { ScreenVideoHealth, VideoPlaybackReport } from "../../types/video.js";

/** How far back a pair's samples are summed for the fraction/stall checks
 *  below, and how long a stale pair is still carried in `snapshot()` before
 *  it is read as gone rather than merely quiet. */
export const WINDOW_MS = 60_000;
/** `dropped / decoded` strictly ABOVE this is struggling — 51 dropped of
 *  1000 decoded (5.1%) is; 50 (exactly 5%) is not. See classifyWindow()'s
 *  own comment for why this is `>`, not `>=`. */
export const DROPPED_FRACTION = 0.05;
/** This many stalls or more within the window is struggling on its own,
 *  whatever the dropped fraction says. */
export const STALLS_IN_WINDOW = 3;
/** How long `struggling` stays true after the last sample that kept the
 *  window's own fraction/stall check bad — see the sticky-flag comment on
 *  `Sticky.lastBadAt` for why this is a separate constant from WINDOW_MS
 *  rather than the same read twice. Currently equal in value; the two mean
 *  different things and are named separately on purpose. */
export const CLEAR_AFTER_MS = 60_000;
/** A window whose worst `jitterBufferMs` or `behindNewestMs` is strictly ABOVE
 *  this is lagging: over a second of delay held inside the screen's own
 *  browser. Held for CLEAR_AFTER_MS after the last report over it, the same
 *  hold struggling has. */
export const LAGGING_MS = 1_000;

/** A heartbeat's own cap — see parseVideoReports(). A screen reports one
 *  entry per currently-playing widget instance, so this is generous for any
 *  real layout while still refusing a body trying to make the server hold an
 *  unbounded array. */
export const MAX_REPORTS = 32;

/** The most decoded, dropped or stalls one report may carry. A heartbeat every
 *  10 s at 240 fps is 2400 frames, so this is far above anything real, and it
 *  keeps a window's sums exact: two reports of 1e308 used to sum to Infinity. */
export const MAX_COUNT_PER_REPORT = 100_000;
/** The largest width or height one report may carry. */
export const MAX_DIMENSION = 16_384;
/** The most `jitterBufferMs` or `behindNewestMs` one report may carry: ten
 *  minutes, a bound on what the server will hold, far past anything real. The
 *  page itself sends null for a figure of a minute or more (see
 *  NOT_A_MEASUREMENT_MS in playback-stats.ts), so a report over this is not
 *  from this build's page and is refused whole like any other bad field. */
export const MAX_LAG_MS = 600_000;

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
  jitterBufferMs: number | null;
  behindNewestMs: number | null;
}

/** The two receive-delay figures, each null when nothing carried one. */
export interface LagFigures {
  jitterBufferMs: number | null;
  behindNewestMs: number | null;
}

/** The larger of two figures, null only when both are. */
function maxOrNull(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/** The worse of a lagging pair's two figures and which one it is: the one
 *  number the Screens card and the `[video]` lagging line both state, so the
 *  two cannot name different delays. Ties go to the jitter buffer. */
export function worstLag(figures: LagFigures): { ms: number; what: "jitter buffer" | "behind the newest frame" } {
  const jitter = figures.jitterBufferMs ?? -1;
  const behind = figures.behindNewestMs ?? -1;
  return behind > jitter ? { ms: behind, what: "behind the newest frame" } : { ms: jitter, what: "jitter buffer" };
}

/** A figure in the tenths of a second the card and the log line state it in,
 *  so a peak creeping up inside one displayed tenth is not a moved peak. */
function tenths(ms: number | null): number {
  return ms === null ? -1 : Math.round(ms / 100);
}

/** The lagging peak after one more window: each figure keeps its own worst.
 *  Returns `held` itself unless a figure rose by a whole displayed tenth of a
 *  second — a creeping 1001, 1002, 1003 ms would otherwise be a new episode
 *  object, and so a published `video:state` frame, on every heartbeat for a
 *  number that reads "1.0 s" throughout. */
function raisePeak(held: LagFigures, fresh: LagFigures): LagFigures {
  const jitterBufferMs = maxOrNull(held.jitterBufferMs, fresh.jitterBufferMs);
  const behindNewestMs = maxOrNull(held.behindNewestMs, fresh.behindNewestMs);
  const rose = tenths(jitterBufferMs) > tenths(held.jitterBufferMs) || tenths(behindNewestMs) > tenths(held.behindNewestMs);
  return rose ? { jitterBufferMs, behindNewestMs } : held;
}

/** The worst of each figure across `samples`. */
function worstFigures(samples: readonly Sample[]): LagFigures {
  let jitterBufferMs: number | null = null;
  let behindNewestMs: number | null = null;
  for (const s of samples) {
    jitterBufferMs = maxOrNull(jitterBufferMs, s.jitterBufferMs);
    behindNewestMs = maxOrNull(behindNewestMs, s.behindNewestMs);
  }
  return { jitterBufferMs, behindNewestMs };
}

/**
 * One sticky flag with its episode — what `struggling` and `lagging` both are.
 * The two differ only in what makes a report bad and in how their peak moves;
 * the hold, the clear by time and the episode identity are this one piece of
 * code, so they cannot drift apart.
 */
interface Sticky<E> {
  /**
   * The last time a report was itself bad AND its check held — null if never.
   * The flag is read off THIS, not off a fresh check of the window: a clean
   * report arriving while a bad one is still inside the window adds its own
   * (large) counts to the sums, which would otherwise DILUTE the check back
   * under threshold long before the bad report itself ages out, clearing the
   * flag on a technicality rather than on 60 clean seconds. Recording
   * `lastBadAt` and comparing it to `now` directly is what makes "a clean
   * report 30 s later keeps it on; clean reports until 60 s after the last
   * bad one clear it" true however much clean traffic arrives in between.
   */
  lastBadAt: number | null;
  /**
   * `isHeldAt(lastBadAt, at)` as advanceSticky() last computed it, or false
   * once sweepSticky() has seen it run out by time — read back as the next
   * call's "was it on", never re-derived fresh against the new `now`. The
   * flag clears purely from elapsed wall-clock time, with no call landing at
   * the exact moment it happens; the first call to notice is whichever one
   * happens next, however much later that is. A FRESH recompute of the old
   * state (the OLD `lastBadAt` against the NEW `now`) would already read
   * past the clear boundary on both sides of the comparison, matching each
   * other and reporting no flip, so neither `changed` nor the clear log line
   * would ever fire. A stored fact is immune to how much time has passed.
   */
  on: boolean;
  /**
   * The peak since the flag last turned on, null whenever it is off. Reset to
   * a fresh reading (never merged with the old one) the moment the flag turns
   * on from off — a NEW episode's peak must never start from a cleared
   * episode's numbers. Replaced, never mutated, so a new object is exactly
   * "the peak moved". Each flag supplies its own rule for when it moves.
   */
  episode: E | null;
  /**
   * This episode's identity — minted only the moment the flag turns on from
   * off, null whenever `episode` is. UNLIKE `episode`'s own object identity,
   * it does NOT change when the peak merely moves inside an ongoing episode:
   * video-service.ts's log uses this, not `episode`'s reference, to tell a
   * genuinely new episode from a worsening one, including a flag that reads
   * on both before and after one record() call because sweep() cleared it
   * and the same call's report re-armed it, with nothing outside ever seeing
   * the flip.
   */
  episodeId: number | null;
}

function newSticky<E>(): Sticky<E> {
  return { lastBadAt: null, on: false, episode: null, episodeId: null };
}

/** Clears a flag whose hold has run out by time alone, so the next bad report
 *  seeds a NEW episode. Returns whether it cleared. */
function sweepSticky(s: Sticky<unknown>, now: number): boolean {
  if (!s.on || isHeldAt(s.lastBadAt, now)) return false;
  s.on = false;
  s.episode = null;
  s.episodeId = null;
  return true;
}

/**
 * Folds one report into a flag. `bad` is the caller's own verdict on THIS
 * report (and, for struggling, on the window it leaves) — it re-arms the hold
 * only when true, never off the window alone (see Sticky.lastBadAt). `fresh`
 * is the episode this call's window would seed; `peak` decides, once the flag
 * was already on, whether the held episode or `fresh` stands, and must return
 * the held object itself when nothing got worse.
 *
 * @returns the new state, and whether the flag flipped or the held peak moved
 *   — the part of `changed` this flag contributes.
 */
function advanceSticky<E>(
  prev: Sticky<E>,
  bad: boolean,
  now: number,
  fresh: E,
  peak: (held: E, fresh: E) => E,
  mintId: () => number,
): { next: Sticky<E>; changed: boolean } {
  const lastBadAt = bad ? now : prev.lastBadAt;
  const on = isHeldAt(lastBadAt, now);
  let episode = prev.episode;
  let episodeId = prev.episodeId;
  if (!on) {
    episode = null;
    episodeId = null;
  } else if (!prev.on || episode === null) {
    episode = fresh;
    episodeId = mintId();
  } else {
    episode = peak(episode, fresh);
  }
  return { next: { lastBadAt, on, episode, episodeId }, changed: prev.on !== on || (on && episode !== prev.episode) };
}

/** The peak a struggling pair holds: one window's totals and the frame size. */
interface StruggleEpisode {
  dropped: number;
  decoded: number;
  stalls: number;
  width: number;
  height: number;
}

interface Pair {
  via: "webrtc" | "hls";
  width: number;
  height: number;
  /** This pair's last report — see ScreenVideoHealth's own comment. */
  reportedAt: number;
  /** Pruned to WINDOW_MS on every touch (record()/snapshot()). */
  samples: Sample[];
  /** Whether this pair is struggling, and its peak window — see Sticky. */
  struggle: Sticky<StruggleEpisode>;
  /** Whether this pair is lagging, and its worst figures — see Sticky. */
  lag: Sticky<LagFigures>;
}

export interface Totals {
  decoded: number;
  dropped: number;
  stalls: number;
}

/**
 * A single comparable measure of how bad ONE window's totals are, used only
 * to decide whether a later window inside the same episode becomes the new
 * peak (see Sticky.episode's own comment) — never to decide struggling itself,
 * which stays classifyWindow()'s own `>`/`>=` rules.
 *
 * Both axes are normalized against their OWN threshold (1.0 is exactly the
 * line classifyWindow() draws on that axis), so a window that is mildly over
 * on both counts can still lose to one that is badly over on just one, and a
 * stall-only episode's peak is judged purely on stalls without a zero
 * dropped-fraction pulling it down.
 */
function severity(totals: Totals): number {
  const droppedRatio =
    totals.decoded === 0
      ? totals.dropped > 0
        ? Number.POSITIVE_INFINITY
        : 0
      : totals.dropped / totals.decoded / DROPPED_FRACTION;
  const stallRatio = totals.stalls / STALLS_IN_WINDOW;
  return Math.max(droppedRatio, stallRatio);
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
 * Which of the two thresholds one window's totals cross: more than
 * DROPPED_FRACTION of decoded frames dropped, and STALLS_IN_WINDOW stalls or
 * more. The one statement of the struggle rule — isBadWindow() below arms the
 * sticky flag on either, and the Screens card (outputs-section.tsx) picks its
 * sentences by which, so the two cannot disagree on where the lines are.
 *
 * `>`, not `>=`: 50 dropped of 1000 decoded is exactly 5% and must read as
 * NOT struggling; 51 is 5.1% and must. Flip this to `>=` and the "50
 * dropped: not struggling" case goes red — that is the guard's own proof.
 */
export function classifyWindow(totals: Totals): { droppedBad: boolean; stallsBad: boolean } {
  return {
    droppedBad: totals.decoded === 0 ? totals.dropped > 0 : totals.dropped / totals.decoded > DROPPED_FRACTION,
    stallsBad: totals.stalls >= STALLS_IN_WINDOW,
  };
}

/** Whether this window's own totals are bad enough to (re)arm the sticky
 *  flag — never read directly as `struggling` itself; see `Sticky.lastBadAt`. */
function isBadWindow(totals: Totals): boolean {
  const { droppedBad, stallsBad } = classifyWindow(totals);
  return droppedBad || stallsBad;
}

/** Whether a sticky flag reads true AT `at`, given the last time its own
 *  check was bad — the one place record(), sweep() and snapshot() do this for
 *  BOTH flags (struggling off `lastBadAt`, lagging off `lastLaggingAt`), so
 *  they can never drift on what "held for CLEAR_AFTER_MS" means. */
function isHeldAt(lastBadAt: number | null, at: number): boolean {
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
  /** The next Sticky.episodeId to mint — see its own field comment. A plain
   *  incrementing counter, never a timestamp: two episodes starting from
   *  record() calls at the exact same `now` (the sweep-then-reflag scenario
   *  this exists for is precisely that) must still mint DIFFERENT ids. */
  private nextEpisodeId = 1;

  private pruneSamples(samples: readonly Sample[], now: number): Sample[] {
    return samples.filter((s) => now - s.at < WINDOW_MS);
  }

  /**
   * Brings every pair (any output, not only the one reporting) up to `now`
   * without a report of its own: removes a pair whose last report is
   * WINDOW_MS or older, and clears the sticky flag and episode of a pair
   * whose flag has run out by time alone. Run at the start of every record()
   * call and by tick() — presence heartbeats arrive roughly every 10 s from
   * any screen currently playing something (see VideoPlaybackReport's own
   * comment), so in a building with more than one screen live this doubles
   * as the sweep that notices ANOTHER screen going quiet, not only the one
   * that just called in. A lone screen that stops reporting entirely is still
   * caught the next time anything reads `snapshot()` — its own defensive age
   * check does not depend on this sweep having run.
   *
   * Clearing each flag and its episode here, not only in record() for the
   * pair reporting, is what makes the next bad report on a time-cleared pair
   * a NEW episode: advanceSticky() reads "was it on" off the stored flag, and
   * a stale `true` kept the cleared episode's numbers as the new one's peak.
   *
   * @returns whether `snapshot()` now reads differently — a pair left, or a
   *   flag cleared — folded into record()'s own `changed` result.
   */
  private sweep(now: number): boolean {
    let changed = false;
    for (const [outputId, byFeed] of this.pairs) {
      for (const [feedId, pair] of byFeed) {
        if (now - pair.reportedAt >= WINDOW_MS) {
          byFeed.delete(feedId);
          changed = true;
          continue;
        }
        // Both, never short-circuited: a pair can clear both in one pass.
        if (sweepSticky(pair.struggle, now)) changed = true;
        if (sweepSticky(pair.lag, now)) changed = true;
      }
      if (byFeed.size === 0) this.pairs.delete(outputId);
    }
    return changed;
  }

  /**
   * Records one heartbeat's reports for one screen. `reports` must already
   * be refusal-checked (parseVideoReports) and filtered to feed ids this
   * server currently holds — record() trusts both, the same contract
   * markRequested() documents in video-service.ts for its own caller.
   *
   * @returns whether `snapshot()` would now read differently: a struggling
   *   flag flipped (here, or cleared by time in this call's sweep), a pair
   *   appeared, a pair left (aged out, this call or a previous one this
   *   call's sweep just noticed), or a currently-struggling pair's
   *   `episode` moved. A struggling pair's live window moving while its
   *   episode holds is not a change: the Screens card and the log line read
   *   the episode. video-service.ts publishes only then — never on every
   *   heartbeat from a screen playing cleanly, nor from one struggling no
   *   worse than its worst minute.
   */
  record(outputId: string, reports: readonly VideoPlaybackReport[], now: number): boolean {
    let changed = this.sweep(now);
    if (reports.length === 0) return changed;

    const byFeed = this.pairs.get(outputId) ?? new Map<string, Pair>();
    if (!this.pairs.has(outputId)) this.pairs.set(outputId, byFeed);

    // Two widgets on the same screen can report the same feed id — folded
    // together here so a pair stays one entry regardless of how many
    // widgets on this screen are showing it. Order within the heartbeat
    // decides which report's via/width/height wins for a shared feed; there
    // is no single "right" answer when two widgets genuinely differ; both
    // report the same decoder's own frame size in every real case.
    // The receive-delay figures fold as a MAX, not a sum: they are not counts,
    // and the worse of two widgets' views of one feed is the one to act on.
    const merged = new Map<string, { via: "webrtc" | "hls"; width: number; height: number; decoded: number; dropped: number; stalls: number } & LagFigures>();
    for (const r of reports) {
      const acc = merged.get(r.feedId);
      if (acc) {
        acc.decoded += r.decoded;
        acc.dropped += r.dropped;
        acc.stalls += r.stalls;
        acc.via = r.via;
        acc.width = r.width;
        acc.height = r.height;
        acc.jitterBufferMs = maxOrNull(acc.jitterBufferMs, r.jitterBufferMs ?? null);
        acc.behindNewestMs = maxOrNull(acc.behindNewestMs, r.behindNewestMs ?? null);
      } else {
        merged.set(r.feedId, {
          via: r.via,
          width: r.width,
          height: r.height,
          decoded: r.decoded,
          dropped: r.dropped,
          stalls: r.stalls,
          jitterBufferMs: r.jitterBufferMs ?? null,
          behindNewestMs: r.behindNewestMs ?? null,
        });
      }
    }

    for (const [feedId, r] of merged) {
      const existing = byFeed.get(feedId);
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
          jitterBufferMs: maxOrNull(newest.jitterBufferMs, r.jitterBufferMs),
          behindNewestMs: maxOrNull(newest.behindNewestMs, r.behindNewestMs),
        };
      } else {
        samples.push({ at: now, decoded: r.decoded, dropped: r.dropped, stalls: r.stalls, jitterBufferMs: r.jitterBufferMs, behindNewestMs: r.behindNewestMs });
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
      const struggle = advanceSticky(
        existing?.struggle ?? newSticky<StruggleEpisode>(),
        sampleIsBad && isBadWindow(totals),
        now,
        { dropped: totals.dropped, decoded: totals.decoded, stalls: totals.stalls, width: r.width, height: r.height },
        // Only a window STRICTLY worse than the held peak replaces it — see
        // severity()'s own comment.
        (held, fresh) => (severity(fresh) > severity(held) ? fresh : held),
        () => this.nextEpisodeId++,
      );

      // Lagging: re-armed only by THIS report's own figures (the window's
      // worst is over the line exactly when some report in it was, so
      // reading the window instead would re-arm on every clean heartbeat for
      // as long as one old bad report stayed inside it). The peak keeps each
      // figure's own worst.
      const lag = advanceSticky(
        existing?.lag ?? newSticky<LagFigures>(),
        (r.jitterBufferMs ?? 0) > LAGGING_MS || (r.behindNewestMs ?? 0) > LAGGING_MS,
        now,
        worstFigures(samples),
        raisePeak,
        () => this.nextEpisodeId++,
      );

      byFeed.set(feedId, { via: r.via, width: r.width, height: r.height, reportedAt: now, samples, struggle: struggle.next, lag: lag.next });

      // A pair appearing, a flag flipping or a held peak moving is a change.
      // The episode is replaced, never mutated, so a new object is exactly
      // "the peak moved"; the live window moving alone is not: the card and
      // the log read the episode.
      if (!existing || struggle.changed || lag.changed) changed = true;
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

  /** Exposed for tests: how many samples one pair currently holds. */
  samplesHeld(outputId: string, feedId: string): number {
    return this.pairs.get(outputId)?.get(feedId)?.samples.length ?? 0;
  }

  /** A pair's current lagging-episode identity, or null when not lagging —
   *  video-service.ts's logLaggingFlips reads this the way logPlaybackFlips
   *  reads episodeIdFor(), for the same reason: a clear and re-flag inside one
   *  record() call never shows as a flip in a before/after of `lagging`. */
  laggingEpisodeIdFor(outputId: string, feedId: string): number | null {
    return this.pairs.get(outputId)?.get(feedId)?.lag.episodeId ?? null;
  }

  /** A pair's current episode identity, or null when not struggling —
   *  video-service.ts's logPlaybackFlips reads this, never `snapshot()`'s own
   *  `episode` (a fresh object every call, so never comparable by reference
   *  across calls, and equal-by-value even for two genuinely different
   *  episodes that happen to share the same numbers). See Sticky.episodeId's
   *  own comment. */
  episodeIdFor(outputId: string, feedId: string): number | null {
    return this.pairs.get(outputId)?.get(feedId)?.struggle.episodeId ?? null;
  }

  /** Every currently-live pair's health, in no particular order —
   *  video-service.ts and the Screens page both filter/group by outputId or
   *  feedId themselves. A pair whose last report is
   *  WINDOW_MS old or older is left out even if record() has not run since
   *  (and so never swept it out of the underlying map) — this is the
   *  correctness backstop sweep() does not have to be relied on for. */
  snapshot(now: number): ScreenVideoHealth[] {
    const out: ScreenVideoHealth[] = [];
    for (const [outputId, byFeed] of this.pairs) {
      for (const [feedId, pair] of byFeed) {
        if (now - pair.reportedAt >= WINDOW_MS) continue;
        const totals = sumSamples(this.pruneSamples(pair.samples, now));
        // Recomputed fresh, the same way each flag itself always is — never a
        // bare read of the stored episode, which would still show a stale
        // peak for however long it takes the NEXT record() call to notice
        // the sticky flag has actually cleared by elapsed time alone.
        const struggling = isHeldAt(pair.struggle.lastBadAt, now);
        const lagging = isHeldAt(pair.lag.lastBadAt, now);
        const struggleEpisode = struggling ? pair.struggle.episode : null;
        const worst = worstFigures(this.pruneSamples(pair.samples, now));
        out.push({
          outputId,
          feedId,
          via: pair.via,
          struggling,
          droppedInWindow: totals.dropped,
          decodedInWindow: totals.decoded,
          stallsInWindow: totals.stalls,
          lagging,
          jitterBufferMsInWindow: worst.jitterBufferMs,
          behindNewestMsInWindow: worst.behindNewestMs,
          width: pair.width,
          height: pair.height,
          reportedAt: pair.reportedAt,
          episode: struggleEpisode
            ? {
                droppedInWindow: struggleEpisode.dropped,
                decodedInWindow: struggleEpisode.decoded,
                stallsInWindow: struggleEpisode.stalls,
                width: struggleEpisode.width,
                height: struggleEpisode.height,
              }
            : null,
          laggingEpisode: lagging && pair.lag.episode ? { ...pair.lag.episode } : null,
        });
      }
    }
    return out;
  }

  /**
   * The earliest future moment ANY held pair's own state would change with
   * NO further heartbeat: either it ages out of `snapshot()` entirely
   * (`reportedAt + WINDOW_MS`), or a currently-struggling or lagging pair's
   * sticky flag clears (`lastBadAt + CLEAR_AFTER_MS`) — whichever comes first, over every
   * pair. `null` with nothing held. video-service.ts arms its one expiry
   * timer to this and re-arms after every record() and after the timer
   * itself fires — see its own comment for why this is a single timer over
   * every pair rather than one per pair.
   */
  nextExpiryAt(now: number): number | null {
    let earliest: number | null = null;
    for (const byFeed of this.pairs.values()) {
      for (const pair of byFeed.values()) {
        const ageOutAt = pair.reportedAt + WINDOW_MS;
        // No "still in the future" check here, unlike clearAt below: a past
        // ageOutAt is a pair still waiting to be swept, so firing at once is
        // right, and the sweep removes it, so it cannot fire again.
        if (earliest === null || ageOutAt < earliest) earliest = ageOutAt;
        for (const flag of [pair.struggle, pair.lag]) {
          if (flag.lastBadAt === null) continue;
          const clearAt = flag.lastBadAt + CLEAR_AFTER_MS;
          // Only while still in the future: a flag that is not currently on
          // already has clearAt in the past, and scheduling a timer for a
          // moment that has already happened would fire at once, forever,
          // for a fact nothing needs telling again.
          if (clearAt > now && (earliest === null || clearAt < earliest)) earliest = clearAt;
        }
      }
    }
    return earliest;
  }

  /**
   * Runs sweep() — actually removing stale pairs from the map, not merely
   * excluding them from what is returned, and clearing a flag that has run
   * out by time — and returns what `snapshot()` now says. This is the ONE
   * caller with no heartbeat of its own behind it (video-service.ts's
   * one-shot expiry timer): every other caller reaches `sweep()` through
   * `record()`, which always has a fresh report to fold in. Without an
   * actual sweep here, a pair nothing ever heartbeats again (a struggling
   * screen that goes dark) would sit in memory forever — `snapshot()`'s own
   * age check keeps it out of what any READER sees, but never frees it.
   */
  tick(now: number): ScreenVideoHealth[] {
    this.sweep(now);
    return this.snapshot(now);
  }
}

function isCountUpTo(max: number): (n: unknown) => n is number {
  return (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
}
const isReportCount = isCountUpTo(MAX_COUNT_PER_REPORT);
const isDimension = isCountUpTo(MAX_DIMENSION);
/** A receive-delay figure: absent or null (a page older than the figures, HLS,
 *  or a browser that cannot measure one) reads as null; anything else must be
 *  a finite number from 0 to MAX_LAG_MS, or the whole array is refused. */
function lagFigure(n: unknown): number | null | undefined {
  if (n === undefined || n === null) return null;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_LAG_MS ? n : undefined;
}

/**
 * `body.video`'s refusal rules: a non-array, more than MAX_REPORTS entries,
 * or any single entry with a non-string/empty `feedId`, a `via` other than
 * "webrtc"/"hls", a decoded/dropped/stalls that is not a whole number from 0
 * to MAX_COUNT_PER_REPORT, or a width/height that is not a whole number from
 * 0 to MAX_DIMENSION, or a `jitterBufferMs`/`behindNewestMs` that is neither
 * absent/null nor a finite number from 0 to MAX_LAG_MS, refuses the WHOLE array — `null`, never a
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
    if (![r.decoded, r.dropped, r.stalls].every(isReportCount)) return null;
    if (![r.width, r.height].every(isDimension)) return null;
    const jitterBufferMs = lagFigure(r.jitterBufferMs);
    const behindNewestMs = lagFigure(r.behindNewestMs);
    if (jitterBufferMs === undefined || behindNewestMs === undefined) return null;
    out.push({
      feedId: r.feedId,
      via: r.via,
      decoded: r.decoded as number,
      dropped: r.dropped as number,
      stalls: r.stalls as number,
      width: r.width as number,
      height: r.height as number,
      jitterBufferMs,
      behindNewestMs,
    });
  }
  return out;
}
