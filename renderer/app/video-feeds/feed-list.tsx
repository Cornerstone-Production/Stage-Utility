// feed-list.tsx — the wide left pane of the Video feeds page: one row per feed
// (its name and status pill, its source line, and a line on how it plays),
// with "Add feed" directly under the last row.

import { PlusIcon } from "lucide-react";

import type { FeedState, VideoFeedView } from "@main/types/video";

import { Button } from "../../components/ui";
import { cn } from "../../lib/cn";
import { bFramesSentence, isObsWhipFeed } from "./b-frames-copy";

/**
 * The row's pill: its text, its tint and its dot, or null for a feed this
 * build cannot see the health of — an "external" source always reports
 * `status.state: null`, and shows no pill.
 *
 * A switch on the full FeedState union, not a lookup table: a FeedState the
 * type system knows about and this function does not fails to compile, rather
 * than silently falling through to "no pill".
 *
 * The tints are the approved design's: live-9 at 12%, warn-9 at 14%,
 * danger-9 at 11%, and the neutral fill. Live text is green-11 in light mode
 * and --su-live-11 in dark: the app's --su-live-11 is the kiosk's light
 * emerald in both themes, which reads as light green on a light green tint.
 * Only the live dot takes the brighter live-9; every other dot is the text
 * colour.
 */
function pillFor(feed: VideoFeedView): { label: string; tint: string; dot: string } | null {
  const live = { tint: "bg-live-9/12 text-green-11 [.dark_&]:text-live-11", dot: "bg-live-9" };
  const state: FeedState | null = feed.status.state;
  switch (state) {
    case null:
      return null;
    case "live":
      return { label: "Live", ...live };
    case "embed":
      return { label: feed.source.kind === "embed" && feed.source.player === "resi" ? "Live on Resi" : "Live on YouTube", ...live };
    case "delayed":
      return { label: "Live, delayed", tint: "bg-warn-9/14 text-warn-11", dot: "bg-current" };
    case "offline":
      return { label: "Offline", tint: "bg-danger-9/11 text-danger-11", dot: "bg-current" };
    case "standby":
      return { label: "Standby", tint: "bg-fill text-fg-muted", dot: "bg-current" };
    case "waiting":
      return { label: "Waiting for source", tint: "bg-fill text-fg-muted", dot: "bg-current" };
  }
}

function FeedPill({ feed }: { feed: VideoFeedView }) {
  const pill = pillFor(feed);
  if (!pill) return null;
  return (
    <span
      className={cn(
        "col-start-2 row-start-1 justify-self-end self-start inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-caption1 font-medium",
        pill.tint,
      )}
    >
      <span className={cn("size-1.5 rounded-full", pill.dot)} />
      {pill.label}
    </span>
  );
}

/**
 * How the feed plays, in the row's muted meta line. Only what this build can
 * know: an embed is the platform's own player, and an external address is
 * played exactly as given with no health to report.
 *
 * A relay (pull/push) feed shows how it plays plus its resolution once the
 * relay reports it: "WebRTC · under 1 s behind" while live (the design's own
 * text), or "HLS · a few seconds behind" once B-frames or an unsupported
 * codec pushes it onto HLS — R14 round 3 item 4: no build in this pipeline
 * computes an actual figure (feed-state.ts, relay.ts's RelayPath carry no
 * such number; the server's own comment for a B-frames close gives a 2-to-6 s
 * RANGE, not a single one), and a delayed row's own hint right below this
 * line already says "a few seconds late" (b-frames-copy.ts) — a specific
 * "about 4 s" here directly above it was never a real measurement and
 * disagreed with its own neighbor. No frame rate either: neither FeedStatus
 * nor the relay's own runtime API reports one anywhere in this pipeline —
 * the approved mockup's sample "30 fps" is sample copy with no real data
 * behind it, so it is left out here rather than invented. A feed that is
 * standby, waiting or offline has nothing to say yet.
 */
export function feedMeta(feed: VideoFeedView): string[] {
  const s = feed.source;
  if (s.kind === "embed") {
    return [s.player === "resi" ? "Plays in Resi's own player" : "Plays in YouTube's own player · 5 to 15 s behind"];
  }
  if (feed.play.via === "external") {
    return [`${feed.play.protocol === "hls" ? "HLS" : "WebRTC"}, played as given`, "Stage Utility cannot see its health"];
  }
  if (feed.play.via === "relay") {
    const status = feed.status;
    if (status.state === "live" || status.state === "delayed") {
      const meta = [status.state === "live" ? "WebRTC · under 1 s behind" : "HLS · a few seconds behind"];
      if (status.width && status.height) meta.push(`${status.width} × ${status.height}`);
      return meta;
    }
  }
  return [];
}

/**
 * R14k: the design's per-row B-frames hint (mockup-v2.html's `.hint` span,
 * distinct from the muted meta line above it) — null for anything else,
 * including a codec-delayed feed (no per-row hint text is specified for
 * that case). The exact sentence the editor's own callout shares
 * (b-frames-copy.ts) — "OBS" only for a push feed set to WHIP, "The
 * device" otherwise, since neither a pull camera nor a push feed on
 * SRT/RTMP is necessarily OBS.
 */
export function bFramesHint(feed: VideoFeedView): string | null {
  if (feed.status.state !== "delayed" || feed.status.delayedBecause !== "b-frames") return null;
  return bFramesSentence(isObsWhipFeed(feed));
}

export function FeedList({
  feeds,
  selectedId,
  onSelect,
  onAddFeed,
}: {
  feeds: readonly VideoFeedView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddFeed: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      {feeds.length === 0 && <p className="border-b border-line px-4 py-3 text-caption1 text-fg-subtle">No feeds yet.</p>}
      {feeds.map((feed) => {
        const meta = feedMeta(feed);
        const hint = bFramesHint(feed);
        return (
          <button
            key={feed.id}
            type="button"
            aria-current={feed.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(feed.id)}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-left transition-colors",
              feed.id === selectedId ? "bg-accent/12" : "hover:bg-fill",
            )}
          >
            <span className="col-start-1 row-start-1 min-w-0 text-[14px] leading-[18px] font-semibold text-fg">{feed.name}</span>
            <FeedPill feed={feed} />
            <span className="col-start-1 font-mono text-caption1 text-fg-muted [overflow-wrap:anywhere]">{feed.sourceLine}</span>
            {meta.length > 0 && (
              <span className="col-span-2 flex flex-wrap gap-x-3.5 gap-y-1 text-caption1 text-fg-subtle">
                {meta.map((m) => (
                  <span key={m}>{m}</span>
                ))}
              </span>
            )}
            {hint && <span className="col-span-2 text-caption1 text-warn-11">{hint}</span>}
          </button>
        );
      })}
      <div className="flex items-center gap-2 px-4 py-3">
        <Button type="button" variant="accent" size="small" onClick={onAddFeed}>
          <PlusIcon className="size-3.5" />
          Add feed
        </Button>
      </div>
    </div>
  );
}
