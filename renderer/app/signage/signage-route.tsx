// signage-route.tsx — the Signage tab.
//
// Five sections over one config load. They are sections rather than routes
// because they are read together: the schedule list needs playlist and group
// names, and the Now board needs all four.

import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import type { ServiceTypeDTO } from "@main/types/stage";
import type { SignageHorizon } from "@main/types/signage";

import { invoke } from "../../lib/api";
import { QUERY_KEYS } from "../queries";
import { useStageState } from "../../main/use-stage-state";
import { useNow } from "./use-now";

import { MediaSection } from "./media-section";
import { GroupsSection } from "./groups-section";
import { PlaylistsSection } from "./playlists-section";
import { ScheduleSection } from "./schedule-section";
import { SIGNAGE_NOW_KEY, useSignageConfig } from "./use-signage-config";

const SECTIONS = ["Now", "Media", "Playlists", "Groups", "Schedule"] as const;
type Section = (typeof SECTIONS)[number];

export function SignageRoute() {
  const [section, setSection] = useState<Section>("Media");
  const { config, loading, error, reload } = useSignageConfig();
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

  const winningIds = useMemo(() => {
    const ids = new Set<string>();
    for (const horizon of Object.values(nowBoard?.horizons ?? {})) {
      const entry = horizon.find((e) => at >= e.from && at < e.until);
      if (entry?.reason === "schedule" && entry.reasonId) ids.add(entry.reasonId);
    }
    return ids;
  }, [nowBoard, at]);

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

      {section === "Media" ? (
        <MediaSection media={config.media} playlists={config.playlists} loading={loading} onChange={reload} />
      ) : section === "Playlists" ? (
        <PlaylistsSection playlists={config.playlists} media={config.media} onChange={reload} />
      ) : section === "Groups" ? (
        <GroupsSection
          groups={config.groups}
          playlists={config.playlists}
          outputs={state?.outputs ?? []}
          views={state?.views ?? []}
          onChange={reload}
        />
      ) : section === "Schedule" ? (
        <ScheduleSection
          schedules={config.schedules}
          groups={config.groups}
          playlists={config.playlists}
          serviceTypes={serviceTypes ?? []}
          winningIds={winningIds}
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
