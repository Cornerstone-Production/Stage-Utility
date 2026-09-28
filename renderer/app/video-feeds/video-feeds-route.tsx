// video-feeds-route.tsx — the Video feeds page under Screens: every feed
// this build knows about, with a live editor beside the list.
//
// PR 1 scope only. The relay's status line and its on/off switch — the top of
// mockup-v2.html's "Video feeds" tab — are PR 2's: there is no relay yet to
// report on. useVideoState()'s `kinds` already limits the Source dropdown to
// what this build actually offers (embed, external — see
// main/services/video/video-service.ts's allowedKinds()), so nothing here
// needs to change when PR 2 widens it (task-6-brief.md).
//
// No stage state is read here for the picture's offline-logo fallback:
// appLogo/appLogoMonochrome are passed as null/false. Wiring useStageState()
// (as rail.tsx does) would pull a second live document and its own SSE
// subscription into a settings page whose only use for it is one fallback
// glyph a feed shows while offline — VideoObject already falls back to the
// plain "is offline" message when appLogo is null (see video-object.tsx's
// OfflineBody), which is exactly what this page shows and is already covered
// by video-object.test.tsx.

import { useState } from "react";
import { Loader2Icon } from "lucide-react";

import type { VideoFeedView } from "@main/types/video";

import { FieldSet } from "../../components/ui";
import { useVideoState } from "../../main/video/use-video-state";
import { FeedEditor } from "./feed-editor";
import { FeedList } from "./feed-list";

export function VideoFeedsRoute() {
  const state = useVideoState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  /**
   * The feed a Save just returned, and the video:state `rev` the page held
   * when it did. Until a push has landed since then, the list still carries
   * the version from before the save — the old name after a rename, or no
   * entry at all for a new feed, which let the editor fall back to
   * `feeds[0]` and flash to some OTHER feed right after a save. So the saved
   * feed wins until `rev` moves, and after that for as long as the list does
   * not carry that id at all.
   */
  const [pending, setPending] = useState<{ feed: VideoFeedView; rev: number } | null>(null);

  if (!state) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  const feeds = state.feeds;
  const fromList = creatingNew ? null : (feeds.find((f) => f.id === selectedId) ?? null);
  const justSaved =
    pending && pending.feed.id === selectedId && (state.rev === pending.rev || !fromList) ? pending.feed : null;
  // Null covers both "explicitly creating one" and "there is nothing to
  // select yet" (an empty list) — either way the editor's isNew form is what
  // belongs on screen.
  const selected = creatingNew ? null : (justSaved ?? fromList ?? feeds[0] ?? null);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-subheadline font-semibold text-fg">Video feeds</h1>
        <p className="text-footnote text-fg-muted">Shows camera and program feeds in layouts and on Home</p>
      </div>
      <FieldSet className="grid grid-cols-1 lg:grid-cols-[minmax(0,320px)_1fr] divide-y lg:divide-y-0 lg:divide-x divide-line">
        <FeedList
          feeds={feeds}
          selectedId={selected?.id ?? null}
          onSelect={(id) => {
            setCreatingNew(false);
            setPending(null);
            setSelectedId(id);
          }}
          onAddFeed={() => {
            setCreatingNew(true);
            setPending(null);
          }}
        />
        <FeedEditor
          // Keyed by what's selected, so switching feeds (or starting a new
          // one) remounts with a fresh draft rather than carrying over the
          // previous feed's unsaved edits — Cancel handles reverting THIS
          // feed's edits; this handles moving to a different one. NOT keyed
          // off the saved feed vs. fromList — both share the selected feed's
          // id, so the pushed list catching up to the save does not itself
          // force a remount and discard any further in-progress edit.
          key={selected?.id ?? "new"}
          feed={selected}
          isNew={selected === null}
          kinds={state.kinds}
          appLogo={null}
          appLogoMonochrome={false}
          onSaved={(feed) => {
            setCreatingNew(false);
            setSelectedId(feed.id);
            setPending({ feed, rev: state.rev });
          }}
          onDeleted={() => {
            setCreatingNew(false);
            setPending(null);
            setSelectedId(null);
          }}
          onCancelNew={() => setCreatingNew(false)}
        />
      </FieldSet>
    </div>
  );
}
