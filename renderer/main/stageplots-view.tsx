// stageplots-view.tsx — /stageplots, read-only: every venue's stage plots, for a
// volunteer at load-in as much as for the desk.
//
// The venue list (home venues, then offsite) opens one venue: its plots as
// tabs, the default selected and marked, the plot itself with pinch zoom and
// pan, its legend, and the venue's notes. A tap on an item shows its label,
// notes and inputs beside it (a bottom sheet on a phone); Print lays the plot
// on one landscape page. With exactly one home venue it opens that venue
// straight away, and the browser remembers the last venue opened. Live: an edit
// anywhere redraws it without a reload (useStagePlots).
//
// It follows the live or next Planning Center plan the way /patch does
// (useFollowedPlan): each venue shows that plan's override if it has one, else
// its default, and says which ("For this plan · Sun 15 Nov" or "Default").
// While Planning Center cannot be read, every venue shows its default under a
// notice saying so.

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ChevronLeftIcon, MaximizeIcon, MinusIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";

import { PLOT_UNITS_WIDE, type BackgroundView, type Plot, type PlotOverride, type StagePlotsView, type Venue } from "@main/types/stageplots";
import { plural } from "@main/services/plural";
import { plotHeight, resolvePlot } from "@main/services/stageplots-doc";

import { usePageActions } from "../app/page-actions";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorNote } from "../components/ui/error-note";
import { cn } from "../lib/cn";
import { readStored, removeStored, writeStored } from "../lib/safe-storage";
import { useResyncOn } from "../lib/use-resync-on";
import { PrintControl } from "./stageplots-print";
import { backgroundOf, eyebrow, plotsOf, selectedPlot, tabClass, venueGroups } from "./stageplots/doc-helpers";
import { ItemDetails, detailsPosition } from "./stageplots/item-details";
import { Mono } from "./stageplots/mono";
import { PlotLegend } from "./stageplots/plot-legend";
import { PlotSvg } from "./stageplots/plot-svg";
import { useFollowedPlan, type FollowedPlan } from "./stageplots/plan-following";
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

/** "Planning Center is unreachable, showing the default plot." Above the page. */
function UnreachableNotice() {
  return (
    <div
      role="status"
      className="mb-3 flex items-start gap-2.5 rounded-[10px] border border-line-strong bg-surface px-3 py-[9px] text-caption1 text-fg shadow-[var(--su-shadow-1)]"
    >
      <TriangleAlertIcon className="mt-px size-4 shrink-0 text-warn-11" aria-hidden />
      <span>Planning Center is unreachable, showing the default plot.</span>
    </div>
  );
}

function VenueCard({ doc, venue, plan, onOpen }: { doc: StagePlotsView; venue: Venue; plan: FollowedPlan; onOpen: () => void }) {
  const plots = plotsOf(doc, venue);
  const resolved = resolvePlot(doc, venue.id, plan.resolvedPlanId);
  const shown = resolved.plot ?? plots[0];
  const background = backgroundOf(doc, shown);
  const why = resolved.reason === "plan" && shown ? `${shown.name} for this plan` : "Default";
  const summary = plots.length === 0 ? "No plots yet" : [plural(plots.length, "plot"), why, ...(background ? [] : ["no background"])].join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[84px_minmax(0,1fr)] items-center gap-3 rounded-xl border border-line bg-surface p-2 text-left shadow-[var(--su-shadow-1)] transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:grid-cols-[96px_minmax(0,1fr)]"
    >
      <span className="block h-14 w-[84px] overflow-hidden rounded-md border border-line bg-[var(--su-plot-paper)] sm:h-16 sm:w-24">
        {shown && <PlotSvg plot={shown} background={background} fade={shown.bgFade} decorative labels={false} className="h-full w-full" />}
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

function VenueList({ doc, plan, onOpen }: { doc: StagePlotsView; plan: FollowedPlan; onOpen: (id: string) => void }) {
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
            <VenueCard key={v.id} doc={doc} venue={v} plan={plan} onOpen={() => onOpen(v.id)} />
          ))}
        </div>
      ))}
    </div>
  );
}

const zoomButton =
  "touch-target inline-grid size-6 place-items-center rounded-md text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [&_svg]:size-3.5";

/** How far, in screen pixels, a press may move and still be a tap rather than a pan. */
const TAP_SLOP_PX = 6;

function PlotFrame({ plot, background }: { plot: Plot; background: BackgroundView | null }) {
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
      {tapped && <ItemDetails item={tapped} at={tap?.at ?? null} onClose={() => setTap(null)} />}
    </div>
  );
}

const badge = "inline-flex h-[22px] items-center gap-1.5 rounded-full px-[9px] text-[11px] leading-[13px] font-medium whitespace-nowrap";

function VenuePage({ doc, venue, plan, onBack }: { doc: StagePlotsView; venue: Venue; plan: FollowedPlan; onBack: () => void }) {
  const plots = plotsOf(doc, venue);
  const resolved = resolvePlot(doc, venue.id, plan.resolvedPlanId);
  // A tab picked by hand holds only while the plan's plot is the one it was
  // picked over: when the plan moves on (or Planning Center drops), the new
  // plan's plot is selected again rather than hidden behind an old pick.
  const [picked, setPicked] = useState<{ venueId: string; plotId: string; over: string | null } | null>(null);
  const pick = picked && picked.over === (resolved.plot?.id ?? null) ? picked : null;
  const selected = selectedPlot(venue, plots, pick, resolved.plot?.id);
  const background = backgroundOf(doc, selected);
  const forPlan = !!selected && resolved.reason === "plan" && selected.id === resolved.plot?.id;
  const isDefault = !!selected && resolved.reason === "default" && selected.id === venue.defaultPlotId;
  const day = forPlan ? plan.label : null;
  const planLabel = day ? `For this plan · ${day}` : "For this plan";
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
        {selected && (
          <PrintControl
            className="ml-auto"
            venueName={venue.name}
            plotName={selected.name}
            planLine={forPlan ? planLabel : selected.id === venue.defaultPlotId ? "Default plot" : null}
            items={selected.items}
            background={background}
            fade={selected.bgFade}
          />
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
                onClick={() => setPicked({ venueId: venue.id, plotId: p.id, over: resolved.plot?.id ?? null })}
                className={tabClass(p.id === selected.id)}
              >
                {p.name}
                {p.id === venue.defaultPlotId && (
                  <span className="rounded border border-line-strong px-1 text-[10px] leading-[14px] font-medium text-fg-subtle">Default</span>
                )}
              </button>
            ))}
          </div>
          <PlotFrame key={selected.id} plot={selected} background={background} />
          <p className="mt-2.5 text-caption1 text-fg-subtle sm:hidden">Pinch to zoom, drag to pan. Tap an item for its details.</p>
          <PlotLegend items={selected.items} className="su-card mt-3 px-3.5 py-2.5" />
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

const NO_OVERRIDES: readonly PlotOverride[] = [];

export function StagePlotsPage() {
  const { doc, loading, error } = useStagePlots();
  const plan = useFollowedPlan(doc?.overrides ?? NO_OVERRIDES);
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

  // Held until the plan is known too: drawn on the plots alone, a venue would
  // show its default and then swap to this plan's plot.
  if (!doc || !plan.known) {
    return (
      <div className="pt-5 max-sm:pt-4">
        {error && !doc ? <ErrorNote>Couldn&apos;t load the stage plots.</ErrorNote> : loading || !plan.known ? <p className="text-footnote text-fg-subtle">Loading…</p> : null}
      </div>
    );
  }
  const venue = openVenue(doc, open);
  return (
    <div className="pt-5 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:pt-3 sm:max-w-[1100px]">
      {error && <ErrorNote className="mb-3">Couldn&apos;t refresh the stage plots; showing the last ones read.</ErrorNote>}
      {plan.unreachable && <UnreachableNotice />}
      {venue ? (
        <VenuePage
          doc={doc}
          venue={venue}
          plan={plan}
          onBack={() => {
            remember(null);
            setOpen({ kind: "list" });
          }}
        />
      ) : (
        <div className="sm:max-w-[380px]">
          <VenueList
            doc={doc}
            plan={plan}
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
