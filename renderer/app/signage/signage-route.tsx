// signage-route.tsx — the Signage tab.
//
// Five sections over one config load. They are sections rather than routes
// because they are read together: the schedule list needs playlist and group
// names, and the Now board needs all four.

import { useCallback, useMemo, useState } from "react";
import { UploadCloudIcon } from "lucide-react";

import { useQuery } from "@tanstack/react-query";
import type { ServiceTypeDTO } from "@main/types/stage";
import type { PcoWindow, SignageHorizon } from "@main/types/signage";

import { errorMessage } from "@main/services/errors";
import { Button } from "../../components/ui/button";
import { toast } from "../../components/ui/toast";
import { invoke } from "../../lib/api";
import { QUERY_KEYS } from "../queries";
import { useStageState } from "../../main/use-stage-state";
import { useNow } from "./use-now";

import { MediaSection } from "./media-section";
import { NowBoard } from "./now-board";
import { PlaylistsSection } from "./playlists-section";
import { ScheduleSection } from "./schedule-section";
import { SIGNAGE_NOW_KEY, useSignageConfig } from "./use-signage-config";
import { uid } from "../../lib/uid";
import { UnsavedGuardProvider, useUnsavedGuard } from "./unsaved-guard";
import { winningOutputsFor, winningScheduleIds } from "./board-entry";

// No "Groups" tab. A tag is not a thing you go and administer — it is assigned
// where the work is: on a playlist ("Default for"), on the Screens page, and
// from a right-click on the Now board.
const SECTIONS = ["Now", "Media", "Playlists", "Schedule"] as const;
type Section = (typeof SECTIONS)[number];

/** "2 playlists and a schedule", rather than "3 changes" — the kinds are what
 *  tell an operator whether they are about to change what is on a wall. */
function describePending(p: { playlists: number; groups: number; schedules: number }): string {
  const parts = [
    p.playlists ? `${p.playlists} playlist${p.playlists === 1 ? "" : "s"}` : "",
    p.groups ? `${p.groups} tag${p.groups === 1 ? "" : "s"}` : "",
    p.schedules ? `${p.schedules} schedule${p.schedules === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "Nothing";
  if (parts.length === 1) return `${parts[0]} is`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]} are`;
}

export function SignageRoute() {
  // The guard has to sit ABOVE the tab strip: the strip is what asks, and the
  // editors inside are what know there is something to ask about.
  return (
    <UnsavedGuardProvider>
      <SignageSections />
    </UnsavedGuardProvider>
  );
}

function SignageSections() {
  const [section, setSection] = useState<Section>("Now");
  // Copied media ids. Held HERE rather than in either section, because the whole
  // point is copying on Media and pasting on Playlists — two tabs that are never
  // mounted at the same time.
  const [clipboard, setClipboard] = useState<string[]>([]);

  const { config, loading, error, reload } = useSignageConfig();
  /** Make a tag and return its id, so a picker can select it immediately. */
  const createGroup = useCallback(
    async (name: string): Promise<string | null> => {
      const group = { id: uid("gr"), name, outputIds: [], createdAt: new Date().toISOString() };
      await invoke("signage:saveGroup", { group });
      await reload();
      return group.id;
    },
    [reload],
  );
  // Outputs and views come from the shared stage state, not a signage copy.
  const { state } = useStageState();

  // PCO service types, for a PCO-driven window. Gated the way every other PCO
  // query is: without credentials the request can only fail.
  const { data: serviceTypes } = useQuery({
    queryKey: QUERY_KEYS.serviceTypes,
    queryFn: () => invoke<ServiceTypeDTO[]>("stage:listServiceTypes"),
    enabled: !!state?.pcoConfigured,
  });

  // Which schedules are actually winning somewhere right now, read from the
  // resolver rather than recomputed in the browser.
  const { data: nowBoard } = useQuery({
    queryKey: SIGNAGE_NOW_KEY,
    queryFn: () =>
      invoke<{
        horizons: Record<string, SignageHorizon>;
        pending: { playlists: number; groups: number; schedules: number; total: number };
        pcoWindows: PcoWindow[];
        timeZone: string;
      }>("signage:now"),
    refetchInterval: 5000,
  });
  const pending = nowBoard?.pending ?? { playlists: 0, groups: 0, schedules: 0, total: 0 };
  const [pushing, setPushing] = useState(false);
  const { dirty, confirmLeave } = useUnsavedGuard();

  /** Switch tab, asking first if an editor is holding an unsaved draft. */
  const leaveTo = useCallback(
    async (next: Section) => {
      if (next === section) return;
      if (await confirmLeave()) setSection(next);
    },
    [section, confirmLeave],
  );

  const push = useCallback(async () => {
    setPushing(true);
    try {
      await invoke("signage:publish");
      await reload();
      toast.success("Pushed to the screens");
    } catch (err) {
      // Said out loud. A push that failed silently leaves an operator believing
      // the walls have their edit.
      toast.error(errorMessage(err));
    } finally {
      setPushing(false);
    }
  }, [reload]);

  // Seconds is plenty: this only decides which schedule row is marked.
  const at = useNow(1000);

  // Through boardEntry, which treats a clock a moment behind a freshly rebuilt
  // horizon as its start. Matching strictly made the marker VANISH for a few
  // hundred milliseconds after every reorder, which read as it being slow.
  const horizons = useMemo(() => nowBoard?.horizons ?? {}, [nowBoard]);
  const winningIds = useMemo(() => winningScheduleIds(horizons, at), [horizons, at]);
  const winningOn = useCallback(
    (scheduleId: string) =>
      winningOutputsFor(horizons, at, scheduleId).map(
        (id) => state?.outputs?.find((o) => o.id === id)?.name ?? id,
      ),
    [horizons, at, state?.outputs],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-line" role="tablist" aria-label="Signage sections">
        {SECTIONS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={s === section}
            onClick={() => void leaveTo(s)}
            className={
              s === section
                ? "px-3 pb-2.5 pt-2 text-footnote font-medium text-fg border-b-2 border-accent -mb-px"
                : "px-3 pb-2.5 pt-2 text-footnote text-fg-muted border-b-2 border-transparent -mb-px transition-colors hover:text-fg"
            }
          >
            {s}
            {dirty && s === section ? (
              // A dot, not a word: the editor already shows Save and Discard,
              // and this only has to say which tab is holding something when
              // you are looking at another one.
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-amber-9 align-middle" aria-label="unsaved" />
            ) : null}
          </button>
        ))}
      </div>

      {/* What the editor holds that the walls do not.
          Config edits do not reach a screen until this is pressed — building
          next week's schedule while this week's is on the wall used to change
          the wall as you typed. Schedules already pushed still fire on their
          own, and a take-over still applies instantly; see
          signage-published-store for exactly what is and is not gated. */}
      {pending.total > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-6 bg-amber-3 px-3 py-2">
          <span className="text-footnote text-amber-11">
            {describePending(pending)} not on the screens yet.
          </span>
          <Button
            variant="accent"
            size="small"
            className="ml-auto"
            disabled={pushing}
            onClick={() => void push()}
          >
            <UploadCloudIcon className="size-3.5" />
            Push to screens
          </Button>
        </div>
      ) : null}

      {/* A failed load is stated, never left looking like an empty library. */}
      {error ? (
        <p className="rounded-lg border border-red-6 bg-red-3 px-3 py-2 text-footnote text-red-11">
          {error}
        </p>
      ) : null}

      {section === "Now" ? (
        <NowBoard
          groups={config.groups}
          playlists={config.playlists}
          outputs={state?.outputs ?? []}
          views={state?.views ?? []}
          onChange={reload}
          onCreateGroup={createGroup}
        />
      ) : section === "Media" ? (
        <MediaSection
          media={config.media}
          playlists={config.playlists}
          loading={loading}
          onChange={reload}
          clipboard={clipboard}
          onCopy={setClipboard}
        />
      ) : section === "Playlists" ? (
        <PlaylistsSection
          playlists={config.playlists}
          media={config.media}
          onChange={reload}
          clipboard={clipboard}
          groups={config.groups}
          onCreateGroup={createGroup}
        />
      ) : section === "Schedule" ? (
        <ScheduleSection
          schedules={config.schedules}
          groups={config.groups}
          playlists={config.playlists}
          serviceTypes={serviceTypes ?? []}
          winningIds={winningIds}
          winningOn={winningOn}
          pcoWindows={nowBoard?.pcoWindows ?? []}
          timeZone={nowBoard?.timeZone ?? "UTC"}
          onChange={reload}
        />
      ) : (
        <p className="text-footnote text-fg-subtle">
          {section} is not built yet.
        </p>
      )}
    </div>
  );
}
