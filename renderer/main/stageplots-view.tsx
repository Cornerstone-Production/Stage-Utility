// stageplots-view.tsx — /stageplots, read-only: every venue's stage plots, for a
// volunteer at load-in as much as for the desk.
//
// The venue list (home venues, then offsite) opens one venue: its plots as
// tabs, the default selected and marked, the plot itself with pinch zoom and
// pan, its legend, and the venue's notes. A tap on an item shows its label,
// notes and inputs beside it (a bottom sheet on a phone); Print lays the plot
// on one landscape page. With exactly one home venue it opens that venue
// straight away, and the browser remembers the last venue opened. A venue has
// its own address, /stageplots/<address> (its id until it has one), which
// opening or leaving one keeps current (as a replace) and which wins over the
// remembered venue. Its id and its old addresses open it too, and the bar then
// shows its address; one that names no venue shows the list and leaves the
// address as it was typed. Live: an edit
// anywhere redraws it without a reload (useStagePlots).
//
// It follows the live or next Planning Center plan the way /patch does
// (useFollowedPlan): each venue shows that plan's override if it has one, else
// its default, and says which ("For this plan · Sun 15 Nov" or "Default").
// While Planning Center cannot be read, every venue shows its default under a
// notice saying so.
//
// A connection point linked to the patch shows its device's name and colour, and
// a tap lists the patch channels through it for the followed plan; while the
// patch cannot be read it shows its last name and colour and lists its inputs.

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useParams } from "@tanstack/react-router";
import { PencilIcon, TriangleAlertIcon } from "lucide-react";

import type { PlotOverride, StagePlotsView, Venue } from "@main/types/stageplots";
import { plural } from "@main/services/plural";
import { resolvePlot } from "@main/services/stageplots-doc";
import { resolvePlots, tapChannels, type LinkResolution } from "@main/services/stageplots-patch-link";

import { usePageActions } from "../app/page-actions";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorNote } from "../components/ui/error-note";
import { cn } from "../lib/cn";
import { readStored, removeStored, writeStored } from "../lib/safe-storage";
import { useInAppLink, useRouterHandle } from "../lib/use-search-param";
import { PrintControl } from "./stageplots-print";
import { PLOT_PARAM, STAGEPLOTS_MANAGE_PATH, STAGEPLOTS_SHARED_PATH, VENUE_PARAM, backgroundOf, eyebrow, plotsOf, venueAt, venueGroups, venuePath, venueSegment } from "./stageplots/doc-helpers";
import { Mono } from "./stageplots/mono";
import { PlotSvg } from "./stageplots/plot-svg";
import { useFollowedPlan, type FollowedPlan } from "./stageplots/plan-following";
import { usePatchContext, useStagePlotsPatch } from "./stageplots/use-patch";
import { useStagePlots } from "./stageplots/use-stageplots";
import { BackLink, VenuePlots, type ChannelsOf } from "./stageplots/venue-plots";

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

function VenueList({ doc, plan, onOpen, manage }: { doc: StagePlotsView; plan: FollowedPlan; onOpen: (venue: Venue) => void; manage: boolean }) {
  if (doc.venues.length === 0) {
    return manage ? (
      <EmptyState
        title="No venues yet"
        hint="Add a venue and its plots in the editor."
        action={
          <Button asChild variant="filled" size="small">
            <a href="/stageplots/edit">Edit stage plots</a>
          </Button>
        }
      />
    ) : (
      <EmptyState title="No venues yet" hint="Stage plots show here once they are added in Stage Utility." />
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="venue-list">
      {venueGroups(doc.venues).map((g) => (
        <div key={g.label} className="flex flex-col gap-2">
          <span className={cn(eyebrow, "mt-2")}>{g.label}</span>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-2">
            {g.venues.map((v) => (
              <VenueCard key={v.id} doc={doc} venue={v} plan={plan} onOpen={() => onOpen(v)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function VenuePage({
  doc,
  venue,
  plan,
  onBack,
  channelsOf,
  manage,
}: {
  doc: StagePlotsView;
  venue: Venue;
  plan: FollowedPlan;
  onBack: () => void;
  channelsOf: ChannelsOf;
  /** Inside the app: Edit beside Print, and Add a plot on an empty venue. The crew's page is read-only. */
  manage: boolean;
}) {
  const goInApp = useInAppLink();
  /** Edit opens the editor on this venue and the plot on screen, in the app rather than as a page load; a modified click still opens a new tab. */
  const editLink = (plotId: string) => {
    const search = { [VENUE_PARAM]: venue.id, [PLOT_PARAM]: plotId };
    return {
      href: `/stageplots/edit?${new URLSearchParams(search)}`,
      onClick: (e: MouseEvent<HTMLAnchorElement>) => {
        goInApp(e, { to: "/stageplots/edit", search });
      },
    };
  };
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
      channelsOf={channelsOf}
      {...(manage
        ? {
            emptyAction: (
              <Button asChild variant="filled" size="small">
                <a href={`/stageplots/edit?venue=${encodeURIComponent(venue.id)}`}>Add a plot</a>
              </Button>
            ),
          }
        : {})}
      before={<BackLink onClick={onBack} />}
      actions={(shown) => (
        <span className="ml-auto flex items-center gap-1.5">
          {manage && (
            <Button asChild variant="filled" size="small">
              <a {...editLink(shown.plot.id)}>
                <PencilIcon className="size-3.5" />
                Edit
              </a>
            </Button>
          )}
          <PrintControl
            venueName={venue.name}
            plotName={shown.plot.name}
            planLine={shown.planLine}
            items={shown.plot.items}
            background={shown.background}
            fade={shown.plot.bgFade}
          />
        </span>
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

const NO_LINKS = new Map<string, Map<string, LinkResolution>>();

/**
 * `manage`: the page inside the app, at /stageplots/manage, where the rail leads, with Edit.
 * Without it, the crew's page at /stageplots: no rail or bar (the shell hides them for this
 * path, see active-page.ts), read-only, and drawing its own heading.
 */
export function StagePlotsPage({ venueId, manage = false }: { venueId?: string; manage?: boolean } = {}) {
  const base = manage ? STAGEPLOTS_MANAGE_PATH : STAGEPLOTS_SHARED_PATH;
  const { doc: stored, loading, error } = useStagePlots();
  const plan = useFollowedPlan(stored?.overrides ?? NO_OVERRIDES);
  // Every plot drawn with its linked points resolved: the cards, the plot, its legend and print.
  const patch = useStagePlotsPatch();
  const patchContext = usePatchContext(plan.resolvedPlanId);
  const { doc, links } = useMemo(() => {
    if (!stored) return { doc: null, links: NO_LINKS };
    const r = resolvePlots(stored.plots, patch, patchContext);
    return { doc: r.plots === stored.plots ? stored : { ...stored, plots: r.plots }, links: r.links };
  }, [stored, patch, patchContext]);
  const channelsOf: ChannelsOf = (plot, itemId) => tapChannels(links.get(plot.id)?.get(itemId));
  // The address names the venue shown, however it was opened. /stageplots and
  // /stageplots/<id> are two routes, so moving between them mounts the page afresh.
  const router = useRouterHandle();
  const goTo = (path: string, state?: Record<string, unknown>) => void router?.navigate({ to: path, search: {}, replace: true, ...(state ? { state } : {}) });
  const [open, setOpen] = useState<Open>(() => {
    // The back link asks for the list in the history entry it writes, so the page that
    // mounts there skips the only-home-venue auto-open; a browser Back to that entry asks again.
    if ((router?.state.location as { state?: { list?: boolean } } | undefined)?.state?.list) return { kind: "list" };
    const id = remembered();
    return id ? { kind: "venue", id } : { kind: "auto" };
  });
  // The address names whatever venue is shown, however it was opened (a card, the only
  // home venue, the remembered one, its id or an old address): that is the link to copy or
  // make a QR code of. Compared as the segment, so an address already right is left alone.
  const shownVenue = doc ? (venueId ? venueAt(doc.venues, venueId) : openVenue(doc, open)) : null;
  const shownSegment = shownVenue ? venueSegment(shownVenue) : null;
  useEffect(() => {
    if (shownSegment && shownSegment !== venueId) goTo(`${base}/${encodeURIComponent(shownSegment)}`);
    // goTo changes every render; the address only needs to follow the venue shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSegment, venueId, base]);
  usePageActions(
    manage ? (
      <Button asChild variant="filled" size="small">
        <a href="/stageplots/edit">Edit</a>
      </Button>
    ) : null,
    [manage],
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
  // An address that names a venue wins over the remembered one; one that names none shows the list.
  const venue = shownVenue;
  return (
    <div className={cn("pt-5 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:pt-3", !manage && "mx-auto w-full max-w-[1400px] px-4 sm:px-6")}>
      {/* The crew's page has no app bar above it to name it. */}
      {!manage && !venue && <h1 className="mb-1 text-title3 font-semibold text-fg">Stage plots</h1>}
      {error && <ErrorNote className="mb-3">Couldn&apos;t refresh the stage plots; showing the last ones read.</ErrorNote>}
      {plan.unreachable && <UnreachableNotice />}
      {venue ? (
        <VenuePage
          doc={doc}
          venue={venue}
          plan={plan}
          channelsOf={channelsOf}
          manage={manage}
          onBack={() => {
            remember(null);
            setOpen({ kind: "list" });
            goTo(base, { list: true });
          }}
        />
      ) : (
        <VenueList
          doc={doc}
          plan={plan}
          manage={manage}
          onOpen={(v) => {
            remember(v.id);
            setOpen({ kind: "venue", id: v.id });
            goTo(venuePath(v, base));
          }}
        />
      )}
    </div>
  );
}

/** `/stageplots/<venue address, id or old address>`: the crew's page with that venue open. */
export function StagePlotsVenueRoute() {
  const { venueId } = useParams({ strict: false }) as { venueId?: string };
  return <StagePlotsPage {...(venueId ? { venueId } : {})} />;
}

/** `/stageplots/manage`: the page inside the app, where the rail leads. */
export function StagePlotsManagePage() {
  return <StagePlotsPage manage />;
}

/** `/stageplots/manage/<venue>`: a venue opened inside the app. */
export function StagePlotsManageVenueRoute() {
  const { venueId } = useParams({ strict: false }) as { venueId?: string };
  return <StagePlotsPage manage {...(venueId ? { venueId } : {})} />;
}
