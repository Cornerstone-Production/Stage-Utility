// channel-reports.ts — each event client's reported channel filter, by cid.
//
// A client says which channels it renders (POST /api/events/subscribe) and the
// fan-out skips the rest, so a mic display never receives the 4 Hz spl:metrics
// firehose. The report and the connection it filters arrive separately and in
// either order: the shared worker posts its report as it opens its EventSource,
// so the report can land first. A report therefore waits for a stream or a poll
// client with its cid to CLAIM it. More than one can hold a cid at once (a
// reconnect's new stream can open before the old one's close is seen), so a
// report stays until the last of them lets go.
//
// A report nothing claims used to wait forever: any cid, any number of them,
// for the life of the process (5,000 requests left 49 MB resident). Now an
// unclaimed report waits UNCLAIMED_TTL_MS and no more than MAX_UNCLAIMED wait at
// once. Dropping one loses nothing: a client with no report on file is sent
// every channel, so filtering stays an optimisation and never a correctness
// dependency.
//
// Split out of remote-server.ts, as event-poll.ts is, so the bounds can be
// driven with a clock rather than through a socket and a minute of waiting.

import { plural } from "./plural.js";
import { scrub } from "./scrub.js";

/** A cid longer than this is not one any client mints (a UUID is 36). */
export const MAX_CID_LENGTH = 128;
/** The longest channel name a report may carry; the longest real one is under 30. */
export const MAX_CHANNEL_LENGTH = 64;
/** The most channels one report may name; a page renders a few dozen at most. */
export const MAX_CHANNELS = 128;
/** The largest subscribe body read. MAX_CHANNELS names at the longest, a cid and
 *  the JSON around them come to under 10 KB. */
export const MAX_SUBSCRIBE_BODY_BYTES = 16 * 1024;
/** How long a report waits for its stream or poll client. A real client's
 *  connection follows its report within a second. */
export const UNCLAIMED_TTL_MS = 60_000;
/** The most reports waiting at once; past it the oldest waiting one goes. */
export const MAX_UNCLAIMED = 256;
/** How often a summary of dropped reports may reach the log. */
const DROP_LOG_INTERVAL_MS = 60_000;
/** Ties the log wording below to the constants: change one and the other stops
 *  compiling. The line spells the numbers out because the log scan will not
 *  accept an unscrubbed interpolation, constant or not. */
UNCLAIMED_TTL_MS satisfies 60_000;
MAX_UNCLAIMED satisfies 256;

/** Whether `v` can be a client id: text, and no longer than any client mints. */
export function usableCid(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_CID_LENGTH;
}

export type ReportOutcome =
  /** Stored. `claimed` says whether a connection already holds the cid, which is
   *  when the report changes what anything is sent. */
  | { stored: true; claimed: boolean }
  /** Nothing changed. `error` is set when the body was refused rather than
   *  merely incomplete, and is the sentence a 400 carries. */
  | { stored: false; error?: string };

export interface ChannelReportsOptions {
  /** Injectable clock, so a test can age a report without sleeping. */
  now?: () => number;
}

export class ChannelReports {
  private readonly filters = new Map<string, Set<string>>();
  /** cid → the connections holding it: each stream's response, or the poll
   *  transport's token for a live poll client. */
  private readonly claims = new Map<string, Set<unknown>>();
  /** Reports no connection holds yet, cid → when it arrived. Insertion order is
   *  arrival order, because a repeat report is deleted and re-set. */
  private readonly unclaimed = new Map<string, number>();
  private dropped = 0;
  private lastDropLogMs = -Infinity;
  private readonly now: () => number;

  constructor(opts: ChannelReportsOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** The channels `cid` reported, or undefined for "send it everything". */
  get(cid: string): Set<string> | undefined {
    return this.filters.get(cid);
  }

  /** Reports held, claimed or not. For tests and diagnostics. */
  get size(): number {
    return this.filters.size;
  }

  /** Reports waiting for a connection. For tests and diagnostics. */
  get unclaimedCount(): number {
    return this.unclaimed.size;
  }

  /**
   * Store a client's channel report, from an untrusted body.
   *
   * A missing cid or channel list changes nothing and is not an error, which is
   * how the route has always answered it. A body past a bound is refused whole:
   * no real client sends one, and storing part of it would hold a filter the
   * client never asked for.
   */
  report(cid: unknown, channels: unknown): ReportOutcome {
    if (typeof cid !== "string" || !Array.isArray(channels)) return { stored: false };
    if (!usableCid(cid)) return { stored: false, error: `cid must be 1 to ${MAX_CID_LENGTH} characters` };
    const names = channels.filter((c): c is string => typeof c === "string");
    if (names.length > MAX_CHANNELS) return { stored: false, error: `at most ${MAX_CHANNELS} channels` };
    if (names.some((c) => c.length > MAX_CHANNEL_LENGTH)) {
      return { stored: false, error: `a channel name is at most ${MAX_CHANNEL_LENGTH} characters` };
    }

    const nowMs = this.now();
    this.expire(nowMs);
    this.filters.set(cid, new Set(names));
    const claimed = this.claims.has(cid);
    if (!claimed) {
      this.unclaimed.delete(cid);
      this.unclaimed.set(cid, nowMs);
      while (this.unclaimed.size > MAX_UNCLAIMED) {
        const oldest = this.unclaimed.keys().next().value as string;
        this.forget(oldest);
        this.dropped++;
      }
    }
    this.logDrops(nowMs);
    return { stored: true, claimed };
  }

  /** `holder` (a stream, or a poll client) is connected with this cid: its
   *  report, if any, stays for as long as some holder does. Claiming twice with
   *  the same holder is one claim. */
  claim(cid: string, holder: unknown): void {
    const holders = this.claims.get(cid);
    if (holders) holders.add(holder);
    else this.claims.set(cid, new Set([holder]));
    this.unclaimed.delete(cid);
  }

  /** `holder` has gone. When it was the last one holding `cid`, the report goes
   *  with it. */
  release(cid: string, holder: unknown): void {
    const holders = this.claims.get(cid);
    if (!holders?.delete(holder) || holders.size > 0) return;
    this.claims.delete(cid);
    this.forget(cid);
  }

  /** Drop every unclaimed report older than the wait. Runs on each report, so a
   *  quiet server keeps at most MAX_UNCLAIMED until the next one; public so a
   *  test drives it directly. */
  expire(nowMs = this.now()): void {
    const cutoff = nowMs - UNCLAIMED_TTL_MS;
    for (const [cid, at] of this.unclaimed) {
      if (at > cutoff) break; // arrival order: everything after is newer
      this.forget(cid);
      this.dropped++;
    }
  }

  /** Forget every report and claim. What a stopping server wants. */
  reset(): void {
    this.filters.clear();
    this.claims.clear();
    this.unclaimed.clear();
    this.dropped = 0;
    this.lastDropLogMs = -Infinity;
  }

  private forget(cid: string): void {
    this.filters.delete(cid);
    this.unclaimed.delete(cid);
  }

  /** One line a minute at most, however many reports were dropped: a page that
   *  closed before its stream opened is ordinary, a flood of made-up cids is not,
   *  and the count is what tells them apart. */
  private logDrops(nowMs: number): void {
    if (this.dropped === 0 || nowMs - this.lastDropLogMs < DROP_LOG_INTERVAL_MS) return;
    console.log(
      `[events] dropped ${scrub(plural(this.dropped, "channel report"))} that no stream or poll client claimed ` +
        "(a report waits 60s, and at most 256 wait at once); those clients are sent every channel",
    );
    this.dropped = 0;
    this.lastDropLogMs = nowMs;
  }
}
