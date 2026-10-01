// main/services/video/feed-state.ts — one relay feed's live state, computed
// from the last poll of the relay and what the service already knows.
//
// Pure: no I/O, no clock read. The service decides "recently requested" (from
// markRequested()) and "last seen" (from seen-store.ts) and hands them in, so
// every row of the state table below is a plain input -> output check with
// nothing to fake but a clock.

import type { FeedStatus } from "../../types/video.js";
import type { RelayPath } from "./relay.js";

/**
 * Set once the relay's log has reported a WebRTC session on this path closing
 * for B-frames (relay-log.ts's "b-frames" event). `readyTime` is the path's
 * OWN readyTime at the moment the mark was taken — not a fixed fact about the
 * path, so a later poll whose readyTime has moved on (the source reconnected,
 * possibly with the encoder's settings now fixed) reads as stale rather than
 * standing forever.
 */
export interface BFramesMark {
  readyTime: string | null;
}

export interface FeedStateInput {
  kind: "pull" | "push";
  /** Whether the relay is currently "running" or "failing". Off,
   *  starting, or never attached at all (video switched off) all read the
   *  same way here: nothing yet can tell a genuinely-down source from one
   *  nobody has been able to ask about, so a missing path means "standby"
   *  (neutral), never "offline" (red). Only once the relay is up enough to
   *  actually report on a path — running, or failing after having been —
   *  does a missing path mean the source itself is absent. See
   *  video-service.ts's relayFeedStatus(), which computes this from
   *  relayStatus(). */
  relayUp: boolean;
  /** The relay's own report for this feed's path (relay.status(), keyed by
   *  feed id — see reconcile-plan.ts), or undefined when the relay does not
   *  know about it at all: not yet reconciled, or the relay itself is down. */
  path: RelayPath | undefined;
  bframesMark: BFramesMark | undefined;
  /** A pull feed's source is dialled by the relay only while something is
   *  watching. True once a WHEP/HLS request named this feed long enough ago
   *  that the relay's dial window has run out, and recently enough to still
   *  count (video-service.ts's RECENT_REQUEST_MS) — a feed still being
   *  dialled is not yet evidence of anything. */
  recentlyRequested: boolean;
  /** Epoch ms this feed was last confirmed live, from the seen store; null if
   *  never. */
  lastSeenAt: number | null;
}

export function feedState(i: FeedStateInput): FeedStatus {
  const { kind, relayUp, path, bframesMark, recentlyRequested, lastSeenAt } = i;

  // Video switched off, the relay still starting, or never attached
  // at all — standby, not a red "offline", whatever `path` says. A stale
  // path should never survive this (the service clears lastPaths on every
  // non-running status change), but the relay's own state is what decides
  // this, not an absence this function has no way to explain otherwise.
  if (!relayUp) return { state: "standby" };

  // The relay is up but has no path for this feed at all — reconciliation
  // has not run yet, or the relay lost the feed. Neither "standby" nor
  // "waiting" fits: both mean the relay is fine and simply has nothing to
  // report yet, which this is not.
  if (!path) return { state: "offline", lastSeenAt };

  if (path.ready) {
    const video = path.video;
    const picture = { codec: video?.codec, width: video?.width, height: video?.height, profile: video?.profile };
    if (video?.codec === "H265") return { state: "delayed", delayedBecause: "codec", ...picture };
    if (bframesMark && bframesMark.readyTime === path.readyTime) {
      return { state: "delayed", delayedBecause: "b-frames", ...picture };
    }
    return { state: "live", ...picture };
  }

  // A pull feed's source is on-demand: the relay only dials it while
  // something is watching, so "not ready" with nobody asking is not evidence
  // the source is down — it is evidence nothing has looked.
  if (kind === "pull") {
    return recentlyRequested ? { state: "offline", lastSeenAt } : { state: "standby" };
  }

  // A push feed's device connects on its own schedule; "not ready" with no
  // prior sighting means it has simply never sent anything yet.
  return lastSeenAt === null ? { state: "waiting" } : { state: "offline", lastSeenAt };
}
