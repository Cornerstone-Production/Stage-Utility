// stageplots-view.tsx — /stageplots, read-only: every venue's stage plots, for a
// volunteer at load-in as much as for the desk.
//
// The venue list (home venues, then offsite) opens one venue: its plots as
// tabs, the default selected and marked, the plot itself with pinch zoom and
// pan, and the venue's notes. With exactly one home venue it opens that venue
// straight away, and the browser remembers the last venue opened. Live: an edit
// anywhere redraws it without a reload (useStagePlots).

import { useRef, useState } from "react";
import { ChevronLeftIcon, MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";

import { PLOT_UNITS_WIDE, type BackgroundView, type Plot, type StagePlotsView, type Venue } from "@main/types/stageplots";
import { plural } from "@main/services/plural";

import { usePageActions } from "../app/page-actions";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorNote } from "../components/ui/error-note";
import { cn } from "../lib/cn";
import { readStored, removeStored, writeStored } from "../lib/safe-storage";
import { backgroundOf, eyebrow, plotsOf, selectedPlot, tabClass, venueGroups } from "./stageplots/doc-helpers";
import { Mono } from "./stageplots/mono";
import { PlotSvg, plotHeight } from "./stageplots/plot-svg";
import { usePanZoom } from "./stageplots/use-pan-zoom";
import { useStagePlots } from "./stageplots/use-stageplots";

/** Where the browser keeps the last venue opened. */
export const LAST_VENUE_KEY = "stageplots:lastVenue";

/** The last venue opened. Storage refused (a private window, a locked-down kiosk)
 *  remembers nothing, and the list is shown, which is the answer without it. */
function remembered(): string | null {
  return readStored(LAST_VENUE_KEY, (raw) => raw, null);
}

/** Remembering is a convenience: failing it changes nothing on screen. */
function remember(id: string | null): void {
  if (id) writeStored(LAST_VENUE_KEY, id);
  else removeStored(LAST_VENUE_KEY);
}

function VenueCard({ doc, venue, onOpen }: { doc: StagePlotsView; venue: Venue; onOpen: () => void }) {
  const plots = plotsOf(doc, venue);
  const shown = plots.find((p) => p.id === venue.defaultPlotId) ?? plots[0];
  const background = backgroundOf(doc, shown);
  const summary = plots.length === 0 ? "No plots yet" : [plural(plots.length, "plot"), "Default", ...(background ? [] : ["no background"])].join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[84px_minmax(0,1fr)] items-center gap-3 rounded-xl border border-line bg-surface p-2 text-left shadow-[var(--su-shadow-1)] transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:grid-cols-[96px_minmax(0,1fr)]"
    >
      <span className="block h-14 w-[84px] overflow-hidden rounded-md border border-line bg-[var(--su-plot-paper)] sm:h-16 sm:w-24">
        {shown && <PlotSvg plot={shown} background={background} fade={shown.bgFade} decorative className="h-full w-full" />}
      </span>
      <span className="min-w-0">
        <b className="block truncate text-[14px] leading-[19px] font-semibold text-fg">{venue.name}</b>
        <small className="block text-caption1 text-fg-muted">
          <Mono text={summary} />
        </small>
      </span>
    </button>
  );
}

function VenueList({ doc, onOpen }: { doc: StagePlotsView; onOpen: (id: string) => void }) {
  if (doc.venues.length === 0) {
    return (
      <EmptyState
        title="No venues yet"
        hint="Add a venue and its plots in the editor."
        action={
          <Button asChild variant="filled" size="small">
            <a href="/stageplots/edit">Edit stage plots</a>
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="venue-list">
      {venueGroups(doc.venues).map((g) => (
        <div key={g.label} className="flex flex-col gap-2">
          <span className={cn(eyebrow, "mt-2")}>{g.label}</span>
          {g.venues.map((v) => (
            <VenueCard key={v.id} doc={doc} venue={v} onOpen={() => onOpen(v.id)} />
          ))}
        </div>
      ))}
    </div>
  );
}

const zoomButton =
  "touch-target inline-grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&_svg]:size-3.5";

function PlotFrame({ plot, background }: { plot: Plot; background: BackgroundView | null }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pz = usePanZoom(svgRef, PLOT_UNITS_WIDE, plotHeight(background));
  return (
    <div className="relative">
      <PlotSvg
        svgRef={svgRef}
        plot={plot}
        background={background}
        fade={plot.bgFade}
        viewBox={pz.viewBox}
        gestures={pz.handlers}
        className="w-full touch-none rounded-[10px] border border-line sm:rounded-[0.875rem]"
      />
      <div className="absolute top-2 right-2 flex flex-col gap-0.5 rounded-lg border border-line-strong bg-popover p-0.5 shadow-[var(--su-shadow-1)]">
        <button type="button" className={zoomButton} onClick={pz.zoomIn} aria-label="Zoom in">
          <PlusIcon />
        </button>
        <button type="button" className={zoomButton} onClick={pz.zoomOut} aria-label="Zoom out">
          <MinusIcon />
        </button>
        <button type="button" className={cn(zoomButton, "max-sm:hidden")} onClick={pz.fit} aria-label="Fit">
          <MaximizeIcon />
        </button>
      </div>
    </div>
  );
}

function VenuePage({ doc, venue, onBack }: { doc: StagePlotsView; venue: Venue; onBack: () => void }) {
  const plots = plotsOf(doc, venue);
  const [picked, setPicked] = useState<{ venueId: string; plotId: string } | null>(null);
  const selected = selectedPlot(venue, plots, picked);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex items-center gap-0.5 self-start rounded-md px-1 py-0.5 text-caption1 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ChevronLeftIcon className="size-3.5" />
        Stage plots
      </button>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h1 className="text-title3 font-semibold text-fg">{venue.name}</h1>
        {selected && selected.id === venue.defaultPlotId && (
          <span className="inline-flex h-[22px] items-center rounded-full bg-fill px-[9px] text-[11px] leading-[13px] font-medium text-fg-muted">
            Default
          </span>
        )}
      </div>
      {plots.length === 0 || !selected ? (
        <EmptyState className="mt-3" title="No plots yet" hint="Add one in the editor." />
      ) : (
        <>
          <div role="tablist" aria-label={`Plots in ${venue.name}`} className="mt-2.5 mb-3 flex gap-0.5 overflow-x-auto border-b border-line">
            {plots.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === selected.id}
                onClick={() => setPicked({ venueId: venue.id, plotId: p.id })}
                className={tabClass(p.id === selected.id)}
              >
                {p.name}
                {p.id === venue.defaultPlotId && (
                  <span className="rounded border border-line-strong px-1 text-[10px] leading-[14px] font-medium text-fg-subtle">Default</span>
                )}
              </button>
            ))}
          </div>
          <PlotFrame key={selected.id} plot={selected} background={backgroundOf(doc, selected)} />
          <p className="mt-2.5 text-caption1 text-fg-subtle sm:hidden">Pinch to zoom, drag to pan.</p>
        </>
      )}
      {venue.notes && <p className="mt-2.5 text-caption1 whitespace-pre-line text-fg-muted">{venue.notes}</p>}
    </div>
  );
}

type Open = { kind: "auto" } | { kind: "list" } | { kind: "venue"; id: string };

/** The venue to show, or null for the list. */
export function openVenue(doc: StagePlotsView, open: Open): Venue | null {
  if (open.kind === "venue") return doc.venues.find((v) => v.id === open.id) ?? openVenue(doc, { kind: "auto" });
  if (open.kind === "list") return null;
  const home = doc.venues.filter((v) => v.kind === "home");
  return home.length === 1 ? home[0] : null;
}

export function StagePlotsPage() {
  const { doc, loading, error } = useStagePlots();
  const [open, setOpen] = useState<Open>(() => {
    const id = remembered();
    return id ? { kind: "venue", id } : { kind: "auto" };
  });
  usePageActions(
    <Button asChild variant="filled" size="small">
      <a href="/stageplots/edit">Edit</a>
    </Button>,
    [],
  );

  if (!doc) {
    return (
      <div className="pt-5 max-sm:pt-4">
        {error ? <ErrorNote>Couldn&apos;t load the stage plots.</ErrorNote> : loading ? <p className="text-footnote text-fg-subtle">Loading…</p> : null}
      </div>
    );
  }
  const venue = openVenue(doc, open);
  return (
    <div className="pt-5 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:pt-3 sm:max-w-[1100px]">
      {error && <ErrorNote className="mb-3">Couldn&apos;t refresh the stage plots; showing the last ones read.</ErrorNote>}
      {venue ? (
        <VenuePage
          doc={doc}
          venue={venue}
          onBack={() => {
            remember(null);
            setOpen({ kind: "list" });
          }}
        />
      ) : (
        <div className="sm:max-w-[380px]">
          <VenueList
            doc={doc}
            onOpen={(id) => {
              remember(id);
              setOpen({ kind: "venue", id });
            }}
          />
        </div>
      )}
    </div>
  );
}
