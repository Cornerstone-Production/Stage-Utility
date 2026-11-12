// stageplots-edit.tsx — /stageplots/edit: venues, backgrounds and plots.
//
// Venues and Backgrounds down the left; the selected venue's plots as tabs,
// a toolbar (zoom, background, fade, print) and the plot on the right. Every
// change here is structural and saves at once, broadcasting to every open
// /stageplots; a failed save says so beside the control that made it and the
// page goes on showing what the server holds. Drawing items on a plot, and
// printing one, arrive with the item editor.

import { useCallback, useRef, useState } from "react";
import { ChevronLeftIcon, MaximizeIcon, MinusIcon, PlusIcon, PrinterIcon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { PLOT_UNITS_WIDE, type BackgroundView, type Plot, type StagePlotsView, type Venue } from "@main/types/stageplots";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { ErrorNote } from "../../components/ui/error-note";
import { cn } from "../../lib/cn";
import type { OpenPdf } from "../../lib/pdf-raster";
import { useResyncOn } from "../../lib/use-resync-on";
import { backgroundOf, plotsOf, selectedPlot } from "../../main/stageplots/doc-helpers";
import { PlotSvg, plotHeight } from "../../main/stageplots/plot-svg";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { usePanZoom } from "../../main/stageplots/use-pan-zoom";
import { useStagePlots } from "../../main/stageplots/use-stageplots";
import { BackgroundsCard } from "./stageplots-backgrounds-card";
import { PlotTabs } from "./stageplots-plot-tabs";
import { SaveError, iconButton, type Save } from "./stageplots-shared";
import { VenuesCard } from "./stageplots-venues-card";

function PlotEditor({ doc, venue, plot, save }: { doc: StagePlotsView; venue: Venue; plot: Plot; save: Save }) {
  const background: BackgroundView | null = backgroundOf(doc, plot);
  const svgRef = useRef<SVGSVGElement>(null);
  const pz = usePanZoom(svgRef, PLOT_UNITS_WIDE, plotHeight(background));
  const [error, setError] = useState<string | null>(null);
  // The slider previews on the plot as it moves and saves when it is let go.
  const [fade, setFade] = useState(plot.bgFade);
  useResyncOn([plot.id, plot.bgFade], () => setFade(plot.bgFade));

  const update = async (changes: { backgroundId?: string | null; bgFade?: number }) => {
    const r = await save(() => stageplotsApi.updatePlot(plot.id, changes));
    setError(r.ok ? null : r.error);
    if (!r.ok) setFade(plot.bgFade);
  };
  // Let go, a key up and leaving the slider each commit, so the value last sent
  // is kept: the same fade is sent once, not again before the save lands.
  const [sentFade, setSentFade] = useState(plot.bgFade);
  useResyncOn([plot.id, plot.bgFade], () => setSentFade(plot.bgFade));
  const commitFade = () => {
    const value = Math.round(fade * 100) / 100;
    if (value === sentFade) return;
    setSentFade(value);
    void update({ bgFade: value });
  };

  return (
    <>
      <div role="toolbar" aria-label="Plot tools" className="mb-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        <span className="flex items-center gap-0.5">
          <button type="button" className={cn(iconButton, "size-7")} aria-label="Zoom out" onClick={pz.zoomOut} disabled={pz.zoom <= 1}>
            <MinusIcon className="size-4" />
          </button>
          <span className="min-w-[46px] text-center font-mono text-caption1 text-fg-soft tabular-nums" data-testid="zoom">
            {Math.round(pz.zoom * 100)}%
          </span>
          <button type="button" className={cn(iconButton, "size-7")} aria-label="Zoom in" onClick={pz.zoomIn}>
            <PlusIcon className="size-4" />
          </button>
          <button type="button" className={cn(iconButton, "size-7")} aria-label="Fit" onClick={pz.fit}>
            <MaximizeIcon className="size-4" />
          </button>
        </span>
        <span className="flex items-center gap-0.5">
          <label htmlFor="stageplots-background" className="mr-1.5 text-caption1 text-fg-muted">
            Background
          </label>
          <select
            id="stageplots-background"
            value={plot.backgroundId ?? ""}
            onChange={(e) => void update({ backgroundId: e.target.value || null })}
            className="h-7 max-w-[220px] rounded-md border border-line-strong bg-field px-1.5 text-caption1 text-fg focus:border-focus focus:ring-1 focus:ring-focus focus:outline-none"
          >
            {doc.backgrounds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value="">None (grid)</option>
          </select>
        </span>
        <span className="flex items-center gap-0.5">
          <label htmlFor="stageplots-fade" className="mr-1.5 text-caption1 text-fg-muted">
            Fade
          </label>
          <input
            id="stageplots-fade"
            type="range"
            min={0}
            max={100}
            value={Math.round(fade * 100)}
            disabled={!background}
            onChange={(e) => setFade(Number(e.target.value) / 100)}
            onPointerUp={commitFade}
            onKeyUp={commitFade}
            onBlur={commitFade}
            className="w-[110px] accent-[var(--su-accent)] disabled:opacity-45"
          />
          <span className="min-w-[34px] font-mono text-caption1 text-fg-soft tabular-nums">{Math.round(fade * 100)}%</span>
        </span>
        <span className="flex-1" />
        <Button variant="filled" size="small" disabled title="Print arrives with the item editor">
          <PrinterIcon className="size-3.5" />
          Print
        </Button>
      </div>
      <SaveError message={error} className="mb-2" />
      <div className="su-card overflow-hidden p-0">
        <PlotSvg
          svgRef={svgRef}
          plot={plot}
          background={background}
          fade={fade}
          viewBox={pz.viewBox}
          gestures={pz.handlers}
          className="w-full touch-none rounded-[0.875rem]"
        />
      </div>
      {venue.notes && <p className="mt-2.5 text-caption1 text-fg-muted">{venue.notes}</p>}
    </>
  );
}

export interface StagePlotsEditProps {
  /** How a PDF is opened in the browser; a test hands in its own. */
  openPdf?: (bytes: ArrayBuffer) => Promise<OpenPdf>;
}

export function StagePlotsEdit({ openPdf }: StagePlotsEditProps) {
  const { doc, loading, error, refresh } = useStagePlots();
  const [venueId, setVenueId] = useState<string | null>(null);
  const [plotPick, setPlotPick] = useState<{ venueId: string; plotId: string } | null>(null);
  const [backgroundId, setBackgroundId] = useState<string | null>(null);

  // Every save reads the document again after it, landed or not: a refused
  // change leaves the page showing what the server holds.
  const save: Save = useCallback(
    async (run) => {
      try {
        const value = await run();
        void refresh();
        return { ok: true, value };
      } catch (err) {
        void refresh();
        return { ok: false, error: errorMessage(err) };
      }
    },
    [refresh],
  );

  const header = (
    <div className="pt-1 pb-3">
      <a
        href="/stageplots"
        className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-caption1 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ChevronLeftIcon className="size-3.5" />
        Stage plots
      </a>
      <h1 className="mt-0.5 text-title3 font-semibold text-fg">Edit stage plots</h1>
    </div>
  );

  if (!doc) {
    return (
      <div className="pt-5 pb-[50vh] max-sm:pt-4">
        {header}
        {error ? <ErrorNote>Couldn&apos;t load the stage plots.</ErrorNote> : loading ? <p className="text-footnote text-fg-subtle">Loading…</p> : null}
      </div>
    );
  }

  const venue = doc.venues.find((v) => v.id === venueId) ?? doc.venues[0] ?? null;
  const plots = venue ? plotsOf(doc, venue) : [];
  const plot = selectedPlot(venue, plots, plotPick);

  return (
    <div className="pt-5 pb-[50vh] max-sm:pt-4">
      {header}
      {error && <ErrorNote className="mb-3">Couldn&apos;t refresh the stage plots; showing the last ones read.</ErrorNote>}
      <div className="grid items-start gap-4 lg:grid-cols-[268px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <VenuesCard doc={doc} selected={venue} onSelect={setVenueId} save={save} />
          <BackgroundsCard doc={doc} selectedId={backgroundId} onSelect={setBackgroundId} save={save} {...(openPdf ? { openPdf } : {})} />
        </aside>
        <div className="min-w-0">
          {!venue ? (
            <EmptyState title="Add a venue to start" hint="A venue is a room you play in or a place you visit. Each holds its plots." />
          ) : (
            <>
              <PlotTabs venue={venue} plots={plots} selected={plot} onSelect={(plotId) => setPlotPick({ venueId: venue.id, plotId })} save={save} />
              {plot ? (
                <PlotEditor key={plot.id} doc={doc} venue={venue} plot={plot} save={save} />
              ) : (
                <EmptyState title={`No plots in ${venue.name} yet`} hint="Add one with the + beside the tabs." />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
