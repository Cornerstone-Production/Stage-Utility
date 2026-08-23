// signage-route.tsx — the Signage tab.
//
// Five sections over one config load. They are sections rather than routes
// because they are read together: the schedule list needs playlist and group
// names, and the Now board needs all four.

import { useCallback, useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import type { ServiceTypeDTO } from "@main/types/stage";
import type { SignageHorizon } from "@main/types/signage";

import { invoke } from "../../lib/api";
import { QUERY_KEYS } from "../queries";
import { useStageState } from "../../main/use-stage-state";
import { useNow } from "./use-now";

import { MediaSection } from "./media-section";
import { NowBoard } from "./now-board";
import { PlaylistsSection } from "./playlists-section";
import { ScheduleSection } from "./schedule-section";
import { SIGNAGE_NOW_KEY, useSignageConfig } from "./use-signage-config";
import { newSignageId } from "./ids";
import { winningOutputsFor, winningScheduleIds } from "./board-entry";

// No "Groups" tab. A tag is not a thing you go and administer — it is assigned
// where the work is: on a playlist ("Default for"), on the Screens page, and
// from a right-click on the Now board.
const SECTIONS = ["Now", "Media", "Playlists", "Schedule"] as const;
type Section = (typeof SECTIONS)[number];

export function SignageRoute() {
  const [section, setSection] = useState<Section>("Now");
  // Copied media ids. Held HERE rather than in either section, because the whole
  // point is copying on Media and pasting on Playlists — two tabs that are never
  // mounted at the same time.
  const [clipboard, setClipboard] = useState<string[]>([]);

  const { config, loading, error, reload } = useSignageConfig();
  /** Make a tag and return its id, so a picker can select it immediately. */
  const createGroup = useCallback(
    async (name: string): Promise<string | null> => {
      const group = { id: newSignageId("gr"), name, outputIds: [], createdAt: new Date().toISOString() };
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
    queryFn: () => invoke<{ horizons: Record<string, SignageHorizon> }>("signage:now"),
    refetchInterval: 5000,
  });

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
            onClick={() => setSection(s)}
            className={
              s === section
                ? "px-3 pb-2.5 pt-2 text-footnote font-medium text-fg border-b-2 border-accent -mb-px"
                : "px-3 pb-2.5 pt-2 text-footnote text-fg-muted border-b-2 border-transparent -mb-px transition-colors hover:text-fg"
            }
          >
            {s}
          </button>
        ))}
      </div>

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
