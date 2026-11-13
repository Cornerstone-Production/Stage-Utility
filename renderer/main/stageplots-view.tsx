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

import { useState } from "react";
import { TriangleAlertIcon } from "lucide-react";

import type { PlotOverride, StagePlotsView, Venue } from "@main/types/stageplots";
import { plural } from "@main/services/plural";
import { resolvePlot } from "@main/services/stageplots-doc";

import { usePageActions } from "../app/page-actions";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorNote } from "../components/ui/error-note";
import { cn } from "../lib/cn";
import { readStored, removeStored, writeStored } from "../lib/safe-storage";
import { PrintControl } from "./stageplots-print";
import { backgroundOf, eyebrow, plotsOf, venueGroups } from "./stageplots/doc-helpers";
import { Mono } from "./stageplots/mono";
import { PlotSvg } from "./stageplots/plot-svg";
import { useFollowedPlan, type FollowedPlan } from "./stageplots/plan-following";
import { useStagePlots } from "./stageplots/use-stageplots";
import { BackLink, VenuePlots } from "./stageplots/venue-plots";

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

function VenuePage({ doc, venue, plan, onBack }: { doc: StagePlotsView; venue: Venue; plan: FollowedPlan; onBack: () => void }) {
  return (
    <VenuePlots
      key={venue.id}
      id={venue.id}
      name={venue.name}
      notes={venue.notes}
      plots={plotsOf(doc, venue)}
      defaultPlotId={venue.defaultPlotId}
      resolved={resolvePlot(doc, venue.id, plan.resolvedPlanId)}
      planDay={plan.label}
      backgroundOf={(p) => backgroundOf(doc, p)}
      before={<BackLink onClick={onBack} />}
      actions={(shown) => (
        <PrintControl
          className="ml-auto"
          venueName={venue.name}
          plotName={shown.plot.name}
          planLine={shown.planLine}
          items={shown.plot.items}
          background={shown.background}
          fade={shown.plot.bgFade}
        />
      )}
    />
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
