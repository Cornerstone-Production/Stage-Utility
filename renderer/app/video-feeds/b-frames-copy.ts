// b-frames-copy.ts — the one B-frames sentence shared verbatim by the
// editor's warning callout (feed-editor.tsx's delayWarning) and the list
// row's hint (feed-list.tsx's bFramesHint) — R14 round 2 item 2/R14k.
//
// No numeric delay is tracked anywhere in this pipeline (feed-state.ts, and
// relay.ts's RelayPath carry no such figure) — "a few seconds" is not a
// placeholder for an N this build could compute; it is what the approved
// design's own copy says to show wherever it would otherwise print "about
// N s" and N is unknown, which for this build is always.

import type { VideoFeedView } from "@main/types/video";

/** True only for a push feed set to WHIP — the one case this app KNOWS the
 *  device is OBS. A pull camera, or a push feed on SRT/RTMP, is very
 *  possibly not OBS at all (a Magewell, ProPresenter's own output, anything
 *  else that can push or be pulled from), so it is never called OBS. */
export function isObsWhipFeed(feed: VideoFeedView): boolean {
  return feed.source.kind === "push" && feed.source.protocol === "whip";
}

/**
 * The sentence the callout's body and the list row's hint share verbatim:
 * "OBS is sending B-frames, so screens get this feed a few seconds late.
 * Turn them off for under-a-second playback." for a push feed set to WHIP,
 * or the device variant (capital T, "on the device") for everything else —
 * the exact copy R14k's controller ruling specifies.
 */
export function bFramesSentence(isObsWhip: boolean): string {
  const who = isObsWhip ? "OBS" : "The device";
  const where = isObsWhip ? "" : "on the device ";
  return `${who} is sending B-frames, so screens get this feed a few seconds late. Turn them off ${where}for under-a-second playback.`;
}
