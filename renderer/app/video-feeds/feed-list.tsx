// feed-list.tsx — the left pane of the Video feeds page: every feed, each row
// showing its status pill and source line, plus "Add feed" underneath.

import { PlusIcon } from "lucide-react";

import type { VideoFeedView } from "@main/types/video";

import { Button } from "../../components/ui";
import { cn } from "../../lib/cn";

/**
 * The list row's pill text, or null for a feed this build cannot see the
 * health of — an "external" source always reports `status.state: null` (see
 * main/services/video/video-service.ts's feedStatus and main/types/video.ts's
 * FeedState doc), which is exactly the mockup's "external shows no pill".
 *
 * A switch on the full `FeedState | null` union, not a lookup table: adding a
 * FeedState the type system knows about and this function does not fails to
 * compile, rather than silently falling through to "no pill".
 */
function pillLabel(feed: VideoFeedView): string | null {
  switch (feed.status.state) {
    case null:
      return null;
    case "live":
      return "Live";
    case "delayed":
      return "Live, delayed";
    case "standby":
      return "Standby";
    case "waiting":
      return "Waiting for source";
    case "offline":
      return "Offline";
    case "embed":
      return feed.source.kind === "embed" && feed.source.player === "resi" ? "Live on Resi" : "Live on YouTube";
  }
}

/**
 * `.pill`'s background/text pair, mockup-v2.html: `.pill.live` (green tint),
 * `.pill.warn` (yellow tint), `.pill.off` (the app's own neutral fill), `.pill.bad`
 * (red tint) — reworked onto this app's actual token names rather than the
 * mockup's own `--su-live-tint`/`--su-warn-tint`/`--su-danger-tint`, which do
 * not exist in renderer/styles.css (only flat `-9`/`-11` pairs are defined for
 * the semantic live/warn/danger tokens, no alpha ramp). `bg-<token>-9/10` is
 * the tint idiom already shipped here for exactly this (error-note.tsx's
 * `border-danger-9/40 bg-danger-9/10 text-danger-11`); "off" uses the real
 * `bg-fill`/`text-fg-muted` tokens the mockup's own `--su-fill`/`--su-fg-muted`
 * resolve to. "embed" pills take the live style, per the brief.
 */
function pillTint(state: NonNullable<VideoFeedView["status"]["state"]>): string {
  switch (state) {
    case "live":
    case "embed":
      return "bg-live-9/10 text-live-11";
    case "delayed":
      return "bg-warn-9/10 text-warn-11";
    case "offline":
      return "bg-danger-9/10 text-danger-11";
    case "standby":
    case "waiting":
      return "bg-fill text-fg-muted";
  }
}

/**
 * `.pill .d`'s own rule: `background: currentColor`, overridden ONLY for
 * `.pill.live .d` to the stronger `--su-live-9` (brighter than the live TEXT
 * color, `--su-live-11`) — every other variant's dot just inherits the pill's
 * own text color. "embed" takes the live style here too.
 */
function pillDot(state: NonNullable<VideoFeedView["status"]["state"]>): string {
  return state === "live" || state === "embed" ? "bg-live-9" : "bg-current";
}

/** mockup-v2.html's `.pill`: inline-flex, 6px gap, a 999px pill, 2px/8px
 *  padding, 12px/500 text, no wrap — and `.feed .pill`'s own placement, the
 *  row's top right. */
function FeedPill({ feed }: { feed: VideoFeedView }) {
  const state = feed.status.state;
  const label = pillLabel(feed);
  if (state === null || label === null) return null;
  return (
    <span
      className={cn(
        "ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-caption1 font-medium",
        pillTint(state),
      )}
    >
      <span className={cn("size-1.5 rounded-full", pillDot(state))} />
      {label}
    </span>
  );
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
    <div className="flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto divide-y divide-line">
        {feeds.length === 0 && (
          <p className="px-4 py-6 text-footnote text-fg-subtle">No feeds yet — add one below.</p>
        )}
        {feeds.map((feed) => (
          <button
            key={feed.id}
            type="button"
            aria-current={feed.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(feed.id)}
            className={cn(
              "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
              feed.id === selectedId ? "bg-fill" : "hover:bg-fill/60",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 truncate text-footnote font-medium text-fg">{feed.name}</span>
              <FeedPill feed={feed} />
            </span>
            <span className="truncate text-caption2 text-fg-subtle font-mono">{feed.sourceLine}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-line p-3">
        <Button
          type="button"
          variant="filled"
          size="small"
          onClick={onAddFeed}
          className="w-full justify-center"
        >
          <PlusIcon className="size-3.5" />
          Add feed
        </Button>
      </div>
    </div>
  );
}
