// video-feeds-route.tsx — the Video feeds page under Screens: one card with
// the page's heading, the feed list as its wide pane and the editor beside it,
// as the approved design lays it out.
//
// The relay's status line and on/off switch belong in this card's header too,
// and arrive with the relay; there is nothing to report on without one. Per
// the approved design, the pill and the switch sit
// on the SAME row as the page's own h1 and sub-title, not a separate one —
// see relay-status.tsx's own header comment.
// useVideoState()'s `kinds` already limits the Source dropdown to what this
// build offers, so nothing here changes when that list widens.
//
// No stage state is read here for the picture's offline-logo fallback:
// appLogo/appLogoMonochrome are passed as null/false. Wiring useStageState()
// (as rail.tsx does) would pull a second live document and its own SSE
// subscription into a settings page whose only use for it is one fallback
// glyph a feed shows while offline — VideoObject already falls back to the
// plain "is offline" message when appLogo is null (see video-object.tsx's
// OfflineBody), which is exactly what this page shows and is already covered
// by video-object.test.tsx.

import { useCallback, useState } from "react";
import { DownloadIcon, Loader2Icon, UploadIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import type { IntegrationState } from "@main/types/integrations";
import type { VideoFeedView } from "@main/types/video";

import { Button, FieldSet } from "../../components/ui";
import { toggleIntegration } from "../../components/integrations-panel";
import { useIntegrations } from "../../main/use-integration-states";
import { useVideoProbe, useVideoState } from "../../main/video/use-video-state";
import { flashTarget } from "../flash";
import { VIDEO_PORTS_FLASH_ID } from "../../settings/sections/video-relay-ports";
import { FeedEditor, type DraftRow } from "./feed-editor";
import { ExportPanel, ImportPanel } from "./feed-transfer-panels";
import { FeedList } from "./feed-list";
import { RelayDetailRow, RelayPill, RelaySwitch } from "./relay-status";

/** Typed as string — the generated route union does not satisfy a bare
 *  literal (see integrations-panel.tsx's own VIDEO_FEEDS_ROUTE for the same
 *  reason, the other direction). */
const ADVANCED_ROUTE: string = "/settings/advanced";

export function VideoFeedsRoute() {
  const state = useVideoState();
  // Subscribing is what makes the server ask each pulled camera about its
  // stream, so it lives here and nowhere else: only while this page is open.
  const { probe, receivedAt: probeReceivedAt } = useVideoProbe();
  const { states } = useIntegrations();
  const router = useRouter();
  const [toggling, setToggling] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  /** The new feed's typed name and address, for the list's draft row only. */
  const [draftRow, setDraftRow] = useState<DraftRow>({ name: "", source: "" });
  /** Which of Export / Import holds the right column, in place of the editor. */
  const [panel, setPanel] = useState<"export" | "import" | null>(null);
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

  const onDraftChange = useCallback((d: DraftRow) => setDraftRow(d), []);

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
  const videoEnabled = states.find((s) => s.id === "video")?.enabled === true;

  function toggleVideo(enabled: boolean): void {
    void toggleIntegration(
      "video",
      enabled,
      { label: "Video feeds", setBusy: setToggling, onStateChange: (_next: IntegrationState) => {} },
    );
  }

  function changePorts(): void {
    router.navigate({ to: ADVANCED_ROUTE });
    flashTarget(VIDEO_PORTS_FLASH_ID);
  }

  const editor = (
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
      relayRunning={state.relay.state === "running"}
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
      onDraftChange={onDraftChange}
    />
  );
  const right =
    panel === "export" ? <ExportPanel feeds={feeds} ports={state.ports} /> : panel === "import" ? <ImportPanel /> : editor;

  return (
    <FieldSet>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-4 py-3.5">
        <h2 className="text-subheadline font-semibold text-fg">Video feeds</h2>
        <RelayPill relay={state.relay} />
        <span className="text-caption1 text-fg-muted">Shows camera and program feeds in layouts and on Home</span>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="transparent" size="small" aria-pressed={panel === "export"} className="aria-pressed:bg-fill aria-pressed:text-fg" onClick={() => setPanel(panel === "export" ? null : "export")}>
            <DownloadIcon className="size-3.5" /> Export
          </Button>
          <Button variant="transparent" size="small" aria-pressed={panel === "import"} className="aria-pressed:bg-fill aria-pressed:text-fg" onClick={() => setPanel(panel === "import" ? null : "import")}>
            <UploadIcon className="size-3.5" /> Import
          </Button>
          <RelaySwitch enabled={videoEnabled} toggling={toggling} onToggle={toggleVideo} />
        </span>
      </div>
      <RelayDetailRow
        relay={state.relay}
        enabled={videoEnabled}
        binaryPresent={state.binaryPresent}
        archivePresent={state.archivePresent}
        onChangePorts={changePorts}
      />
      <div className="grid grid-cols-1 min-[900px]:grid-cols-[minmax(0,1fr)_360px]">
        <FeedList
          draft={panel === null && selected === null ? draftRow : null}
          feeds={feeds}
          probe={probe}
          probeReceivedAt={probeReceivedAt}
          screens={state.screens}
          selectedId={selected?.id ?? null}
          onSelect={(id) => {
            setPanel(null);
            setCreatingNew(false);
            setPending(null);
            setSelectedId(id);
          }}
          onAddFeed={() => {
            setPanel(null);
            setDraftRow({ name: "", source: "" });
            setCreatingNew(true);
            setPending(null);
          }}
        />
        {right}
      </div>
    </FieldSet>
  );
}
