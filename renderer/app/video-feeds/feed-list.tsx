// feed-list.tsx — the left pane of the Video feeds page: every feed, each row
// showing its status pill and source line, plus "Add feed" underneath.

import { PlusIcon } from "lucide-react";

import type { VideoFeedView } from "@main/types/video";

import { Button, Status } from "../../components/ui";
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

function pillVariant(state: NonNullable<VideoFeedView["status"]["state"]>): "success" | "warning" | "error" | "neutral" {
  switch (state) {
    case "live":
    case "embed":
      return "success";
    case "delayed":
      return "warning";
    case "offline":
      return "error";
    case "standby":
    case "waiting":
      return "neutral";
  }
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
        {feeds.map((feed) => {
          const label = pillLabel(feed);
          return (
            <button
              key={feed.id}
              type="button"
              aria-current={feed.id === selectedId}
              onClick={() => onSelect(feed.id)}
              className={cn(
                "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors",
                feed.id === selectedId ? "bg-fill" : "hover:bg-fill/60",
              )}
            >
              <span className="flex items-center gap-2">
                <span className="truncate text-footnote font-medium text-fg">{feed.name}</span>
                {label !== null && feed.status.state !== null && (
                  <Status variant={pillVariant(feed.status.state)}>{label}</Status>
                )}
              </span>
              <span className="truncate text-caption2 text-fg-subtle font-mono">{feed.sourceLine}</span>
            </button>
          );
        })}
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
