// feed-list.tsx — the wide left pane of the Video feeds page: one row per feed
// (its name and status pill, its source line, and a line on how it plays),
// with "Add feed" directly under the last row.

import { useEffect, useState } from "react";
import { PlusIcon } from "lucide-react";

import type { FeedState, ScreenVideoHealth, VideoFeedView, VideoProbeEntry, VideoProbeState } from "@main/types/video";

import { Button } from "../../components/ui";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/clock-format";
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

type Pill = { label: string; tint: string; dot: string };

/** The camera check's wording, as the approved status design has it. */
const BUSY_LINE = "The camera is busy answering another request · trying again";
const SRT_UNCHECKED_LINE = "SRT can't be checked without streaming it · shows Live once something plays it";

/** "H264" is how the camera's description spells it; the page says "H.264". */
function codecLabel(codec: string): string {
  return codec.replace(/^H(26[45])$/, "H.$1");
}

/** "4 s ago", or minutes once it has been that long. */
function agoText(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

/**
 * How long ago a camera was checked, without the viewer's clock or the
 * server's being right about the time of day. The server says how old the
 * answer was when it sent the snapshot (its own `at` minus its own
 * `checkedAt`, both one clock); this adds how long this page has held that
 * snapshot, on a monotonic clock. A wall display hours out from the server
 * still reads "4 s ago".
 */
export function checkedAgeMs(probe: VideoProbeState, entry: VideoProbeEntry, receivedAt: number, now: number): number {
  return Math.max(0, probe.at - entry.checkedAt) + Math.max(0, now - receivedAt);
}

/**
 * What a camera check says about a PULLED feed, or null to leave the row to
 * the relay's own reading.
 *
 * Precedence, as the design has it: the relay's own Live or Delayed first
 * (null here, so the existing pill and line stand); then what the probe found.
 * A feed the probe has no entry for (the switch is off, or the page has not
 * heard yet) is also null: Standby as before. Push, embed and external feeds
 * are never probed and never reach this.
 */
export function probeView(
  feed: VideoFeedView,
  entry: VideoProbeEntry | undefined,
  ageMs: number,
): { pill: Pill; line: { text: string; bad: boolean } | null } | null {
  if (feed.source.kind !== "pull" || !entry) return null;
  const state = feed.status.state;
  if (state === "live" || state === "delayed") return null;
  switch (entry.state) {
    case "ready": {
      const picture = [entry.codec ? codecLabel(entry.codec) : null, entry.width && entry.height ? `${entry.width} × ${entry.height}` : null]
        .filter((p): p is string => p !== null)
        .join(" ");
      const parts = ["Camera answers", ...(picture ? [picture] : []), `checked ${agoText(ageMs)}`];
      return { pill: { label: "Ready", tint: "bg-fill text-fg-muted", dot: "bg-live-9" }, line: { text: parts.join(" · "), bad: false } };
    }
    case "failed": {
      const since = entry.since !== undefined ? ` · since ${formatClock(entry.since)}` : "";
      return {
        pill: { label: "Not answering", tint: "bg-danger-9/11 text-danger-11", dot: "bg-current" },
        line: { text: `${entry.reason ?? "The camera did not answer"}${since}`, bad: true },
      };
    }
    case "unchecked":
      return { pill: { label: "Standby", tint: "bg-fill text-fg-muted", dot: "bg-current" }, line: { text: SRT_UNCHECKED_LINE, bad: false } };
    case "checking":
      return {
        pill: { label: "Checking", tint: "bg-fill text-fg-subtle", dot: "bg-current video-probe-checking-dot" },
        line: { text: entry.busy ? BUSY_LINE : "Checking…", bad: false },
      };
  }
}

function FeedPill({ pill }: { pill: Pill | null }) {
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
 * codec pushes it onto HLS — no build in this pipeline
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
 *
 * `screens` adds one more line, whatever the state above: "On N screens" —
 * distinct outputIds currently reporting this feed's id in VideoState.screens,
 * struggling or not. A screen's own playback is a real measure whatever the
 * feed's source is — video-object.tsx registers a sampler for any feed it is
 * actually showing a picture from, embed excepted (a platform iframe Stage
 * Utility cannot see into at all). An external feed can and does raise "On N
 * screens" the same way a relay one does; only a feed with nothing currently
 * playing it reads with no line at all, rather than ever "On 0 screens".
 */
export function feedMeta(feed: VideoFeedView, screens: readonly ScreenVideoHealth[]): string[] {
  const s = feed.source;
  const meta: string[] = [];
  if (s.kind === "embed") {
    meta.push(s.player === "resi" ? "Plays in Resi's own player" : "Plays in YouTube's own player · 5 to 15 s behind");
  } else if (feed.play.via === "external") {
    meta.push(`${feed.play.protocol === "hls" ? "HLS" : "WebRTC"}, played as given`, "Stage Utility cannot see whether its source is live");
  } else if (feed.play.via === "relay") {
    const status = feed.status;
    if (status.state === "live" || status.state === "delayed") {
      meta.push(status.state === "live" ? "WebRTC · under 1 s behind" : "HLS · a few seconds behind");
      if (status.width && status.height) meta.push(`${status.width} × ${status.height}`);
    }
  }
  const onScreens = new Set(screens.filter((sc) => sc.feedId === feed.id).map((sc) => sc.outputId)).size;
  if (onScreens > 0) meta.push(`On ${onScreens} screen${onScreens === 1 ? "" : "s"}`);
  return meta;
}

/**
 * The design's per-row B-frames hint (its `.hint` span,
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

/** A monotonic clock (host clock steps cannot move it), re-read every
 *  `everyMs` — what keeps "checked 4 s ago" from freezing between probe
 *  answers. Always ticking, so it is never more than one interval stale when a
 *  result first appears. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** How often the "checked N s ago" text is re-read. */
const AGE_REFRESH_MS = 5000;

export function FeedList({
  draft,
  feeds,
  probe,
  probeReceivedAt,
  screens,
  selectedId,
  onSelect,
  onAddFeed,
}: {
  /** The unsaved feed being created, shown as the last row; null otherwise. */
  draft?: { name: string; source: string } | null;
  feeds: readonly VideoFeedView[];
  /** The camera checks, or null before the page has heard any. */
  probe: VideoProbeState | null;
  /** performance.now() when `probe` arrived; see checkedAgeMs. */
  probeReceivedAt: number;
  screens: readonly ScreenVideoHealth[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddFeed: () => void;
}) {
  const now = useNow(AGE_REFRESH_MS);
  return (
    <div className="flex min-w-0 flex-col">
      {feeds.length === 0 && !draft && <p className="border-b border-line px-4 py-3 text-caption1 text-fg-subtle">No feeds yet.</p>}
      {feeds.map((feed) => {
        const entry = probe?.feeds[feed.id];
        const checked = probeView(feed, entry, probe && entry ? checkedAgeMs(probe, entry, probeReceivedAt, now) : 0);
        const meta = feedMeta(feed, screens);
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
            <FeedPill pill={checked ? checked.pill : pillFor(feed)} />
            <span className="col-start-1 font-mono text-caption1 text-fg-muted [overflow-wrap:anywhere]">{feed.sourceLine}</span>
            {(checked?.line || meta.length > 0) && (
              <span className="col-span-2 flex flex-wrap gap-x-3.5 gap-y-1 text-caption1 text-fg-subtle">
                {checked?.line && <span className={checked.line.bad ? "text-danger-11" : undefined}>{checked.line.text}</span>}
                {meta.map((m) => (
                  <span key={m}>{m}</span>
                ))}
              </span>
            )}
            {hint && <span className="col-span-2 text-caption1 text-warn-11">{hint}</span>}
          </button>
        );
      })}
      {draft && (
        <div aria-current="true" data-testid="draft-feed-row" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-line bg-accent/12 px-4 py-3 text-left">
          <span className="col-start-1 row-start-1 min-w-0 text-[14px] leading-[18px] font-semibold text-fg [overflow-wrap:anywhere]">
            {draft.name || "New feed"}
          </span>
          <span className="col-start-2 row-start-1 justify-self-end self-start inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-fill px-2 py-0.5 text-caption1 font-medium text-fg-muted">
            <span className="size-1.5 rounded-full bg-current" />
            Not saved
          </span>
          {draft.source ? (
            <span className="col-start-1 font-mono text-caption1 text-fg-muted [overflow-wrap:anywhere]">{draft.source}</span>
          ) : (
            <span className="col-start-1 text-caption1 text-fg-subtle">Not set up yet</span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-3">
        <Button type="button" variant="accent" size="small" onClick={onAddFeed}>
          <PlusIcon className="size-3.5" />
          Add feed
        </Button>
      </div>
    </div>
  );
}
