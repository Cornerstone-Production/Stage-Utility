// signage-route.tsx — the Signage tab.
//
// Five sections over one config load. They are sections rather than routes
// because they are read together: the schedule list needs playlist and group
// names, and the Now board needs all four.

import { useState } from "react";

import { MediaSection } from "./media-section";
import { PlaylistsSection } from "./playlists-section";
import { useSignageConfig } from "./use-signage-config";

const SECTIONS = ["Now", "Media", "Playlists", "Groups", "Schedule"] as const;
type Section = (typeof SECTIONS)[number];

export function SignageRoute() {
  const [section, setSection] = useState<Section>("Media");
  const { config, loading, error, reload } = useSignageConfig();

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
      ) : (
        <p className="text-footnote text-fg-subtle">
          {section} is not built yet.
        </p>
      )}
    </div>
  );
}
