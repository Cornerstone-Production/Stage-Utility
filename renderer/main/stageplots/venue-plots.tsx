// venue-plots.tsx — one venue's plots, read-only: its heading and plan badge, its plots as
// tabs, the plot with pinch zoom and pan and a tap for an item's details, its legend and
// its notes. Drawn from data alone, so /stageplots and the published page
// (renderer/public/stageplots-public.tsx) mount the same component and cannot drift.
// Each page brings what only it has (a back link, a print control) as `before` and
// `actions`; nothing here reads the API, the stage state or the router.

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronLeftIcon, MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";

import { PLOT_UNITS_WIDE, type PatchChannels, type Plot, type PlotBackground } from "@main/types/stageplots";
import { plotHeight, type PlotReason } from "@main/services/stageplots-doc";

import { EmptyState } from "../../components/ui/empty-state";
import { cn } from "../../lib/cn";
import { useResyncOn } from "../../lib/use-resync-on";
import { selectedPlot, tabClass } from "./doc-helpers";
import { ItemDetails, detailsPosition } from "./item-details";
import { Mono } from "./mono";
import { PlotLegend } from "./plot-legend";
import { PlotSvg } from "./plot-svg";
import { usePanZoom } from "./use-pan-zoom";

const zoomButton =
  "touch-target inline-grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&_svg]:size-3.5";

/** How far, in screen pixels, a press may move and still be a tap rather than a pan. */
const TAP_SLOP_PX = 6;

/** A linked point's patch channels on a plot, or null to list its inputs. */
export type ChannelsOf = (plot: Plot, itemId: string) => PatchChannels | null;

export function PlotFrame({ plot, background, channelsOf }: { plot: Plot; background: PlotBackground | null; channelsOf?: ChannelsOf }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const pz = usePanZoom(svgRef, PLOT_UNITS_WIDE, plotHeight(background));
  // A tap is decided from the press and the release, not from click: after the
  // plot captures the pointer, a click names the plot, not the item under it.
  const press = useRef<{ id: string | null; pointerId: number; x: number; y: number } | null>(null);
  const [tap, setTap] = useState<{ id: string; at: { left: number; top: number } | null } | null>(null);
  // Panning or zooming moves the item from under its popover: close it.
  useResyncOn([plot.id, pz.viewBox], () => setTap(null));
  // Escape, or a press anywhere off the plot and off the details, closes them:
  // on a phone the sheet covers the page's foot, and the legend is under it.
  useEffect(() => {
    if (!tap) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTap(null);
    const onDown = (e: Event) => {
      const t = e.target as Element | null;
      if (!t?.closest?.("[data-item-details]") && !svgRef.current?.contains(t)) setTap(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [tap]);
  const tapped = tap ? (plot.items.find((it) => it.id === tap.id) ?? null) : null;

  const gestures = {
    ...pz.handlers,
    onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
      const hit = (e.target as Element).closest?.("[data-id]");
      // Text is read where it stands; it has nothing more to show.
      const id = hit && hit.getAttribute("data-type") !== "text" ? hit.getAttribute("data-id") : null;
      // A second finger is a pinch, never a tap.
      press.current = press.current ? null : { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      pz.handlers.onPointerDown(e);
    },
    // A cancelled press (the browser took the touch for a scroll) is no tap,
    // and must not leave the next press looking like a second finger.
    onPointerCancel: (e: PointerEvent<SVGSVGElement>) => {
      press.current = null;
      pz.handlers.onPointerCancel(e);
    },
    onPointerUp: (e: PointerEvent<SVGSVGElement>) => {
      const p = press.current;
      press.current = null;
      pz.handlers.onPointerUp(e);
      if (!p || p.pointerId !== e.pointerId || Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP_PX) return;
      if (!p.id) return setTap(null);
      const el = svgRef.current?.querySelector(`[data-id="${p.id}"]`);
      const frame = frameRef.current?.getBoundingClientRect();
      setTap({ id: p.id, at: el && frame && frame.width > 0 ? detailsPosition(el.getBoundingClientRect(), frame) : null });
    },
  };

  return (
    <div className="relative" ref={frameRef}>
      <PlotSvg
        svgRef={svgRef}
        plot={plot}
        background={background}
        fade={plot.bgFade}
        view={pz.view}
        gestures={gestures}
        tappedId={tapped?.id ?? null}
        className="w-full touch-none rounded-[10px] border border-line sm:rounded-[0.875rem] [&_[data-id]:not([data-type=text])]:cursor-pointer"
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
      {tapped && <ItemDetails item={tapped} at={tap?.at ?? null} onClose={() => setTap(null)} channels={channelsOf?.(plot, tapped.id) ?? null} />}
    </div>
  );
}

const badge = "inline-flex h-[22px] items-center gap-1.5 rounded-full px-[9px] text-[11px] leading-[13px] font-medium whitespace-nowrap";

/** The back link above a venue: to the venue list. */
export function BackLink({ onClick, label = "Stage plots" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 inline-flex items-center gap-0.5 self-start rounded-md px-1 py-0.5 text-caption1 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <ChevronLeftIcon className="size-3.5" />
      {label}
    </button>
  );
}

/** What a page hands its print control: the plot on screen and how it is labelled. */
export interface ShownPlot {
  plot: Plot;
  background: PlotBackground | null;
  /** "For this plan · Sun 16 Nov", "Default plot", or null. */
  planLine: string | null;
}

export interface VenuePlotsProps {
  /** The venue's id: a tab picked in one venue is never applied to another. */
  id: string;
  name: string;
  notes: string;
  /** In tab order. */
  plots: readonly Plot[];
  defaultPlotId: string | null;
  /** The plot the followed plan shows here, and why. */
  resolved: { plot: Plot | null; reason: PlotReason };
  /** The plan's day ("Sun 16 Nov") when the resolved plot is the plan's, else null. */
  planDay: string | null;
  backgroundOf: (plot: Plot) => PlotBackground | null;
  /** Above the heading: the app's back link. */
  before?: ReactNode;
  /** At the end of the heading row: the app's print control, for the plot on screen. */
  actions?: (shown: ShownPlot) => ReactNode;
  /** Whether a plot's data is current, an older copy kept after a failed read, or not had at all (the published page). Current when absent. */
  plotState?: (plot: Plot) => "ok" | "stale" | "failed";
  /** What a tap on a linked connection point lists: resolved here on /stageplots, read from the published plot on the public page. */
  channelsOf?: ChannelsOf;
}

export function VenuePlots({ id, name, notes, plots, defaultPlotId, resolved, planDay, backgroundOf, before, actions, plotState, channelsOf }: VenuePlotsProps) {
  // A tab picked by hand holds only while the plan's plot is the one it was
  // picked over: when the plan moves on (or Planning Center drops), the new
  // plan's plot is selected again rather than hidden behind an old pick.
  const [picked, setPicked] = useState<{ venueId: string; plotId: string; over: string | null } | null>(null);
  const pick = picked && picked.over === (resolved.plot?.id ?? null) ? picked : null;
  const selected = selectedPlot({ id, defaultPlotId } as Parameters<typeof selectedPlot>[0], plots, pick, resolved.plot?.id);
  const background = selected ? backgroundOf(selected) : null;
  const forPlan = !!selected && resolved.reason === "plan" && selected.id === resolved.plot?.id;
  const isDefault = !!selected && resolved.reason === "default" && selected.id === defaultPlotId;
  const planLabel = planDay && forPlan ? `For this plan · ${planDay}` : "For this plan";
  return (
    <div className="flex flex-col">
      {before}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h1 className="text-title3 font-semibold text-fg">{name}</h1>
        {forPlan && (
          <span className={cn(badge, "bg-accent-soft text-fg")} data-testid="plan-badge">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            {/* One flex item: Mono splits the label into runs, and the gap would part them. */}
            <span>
              <Mono text={planLabel} />
            </span>
          </span>
        )}
        {isDefault && (
          <span className={cn(badge, "bg-fill text-fg-muted")} data-testid="plan-badge">
            Default
          </span>
        )}
        {selected && actions?.({ plot: selected, background, planLine: forPlan ? planLabel : selected.id === defaultPlotId ? "Default plot" : null })}
      </div>
      {plots.length === 0 || !selected ? (
        <EmptyState className="mt-3" title="No plots yet" hint="Add one in the editor." />
      ) : (
        <>
          <div role="tablist" aria-label={`Plots in ${name}`} className="mt-2.5 mb-3 flex gap-0.5 overflow-x-auto border-b border-line">
            {plots.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === selected.id}
                onClick={() => setPicked({ venueId: id, plotId: p.id, over: resolved.plot?.id ?? null })}
                className={tabClass(p.id === selected.id)}
              >
                {p.name}
                {p.id === defaultPlotId && (
                  <span className="rounded border border-line-strong px-1 text-[10px] leading-[14px] font-medium text-fg-subtle">Default</span>
                )}
              </button>
            ))}
          </div>
          {plotState?.(selected) === "failed" ? (
            <p role="alert" className="rounded-[10px] border border-line px-3 py-6 text-center text-footnote text-fg-muted">
              This plot could not be loaded. Try again in a moment.
            </p>
          ) : (
            <>
              {plotState?.(selected) === "stale" && (
                <p role="status" className="mb-2 text-caption1 text-warn-11">
                  Could not refresh this plot; showing the last copy.
                </p>
              )}
              <PlotFrame key={selected.id} plot={selected} background={background} {...(channelsOf ? { channelsOf } : {})} />
              <p className="mt-2.5 text-caption1 text-fg-subtle sm:hidden">Pinch to zoom, drag to pan. Tap an item for its details.</p>
              <PlotLegend items={selected.items} className="su-card mt-3 px-3.5 py-2.5" />
            </>
          )}
        </>
      )}
      {notes && <p className="mt-2.5 text-caption1 whitespace-pre-line text-fg-muted">{notes}</p>}
    </div>
  );
}
