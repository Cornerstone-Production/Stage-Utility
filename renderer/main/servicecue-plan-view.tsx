import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { ErrorNote } from "../components/ui/error-note";
import { useServerClock } from "@renderer/lib/server-clock";
import { ArrowLeftIcon } from "lucide-react";

import { ServiceCueBody, ServiceCueHeader, useServiceCueRender } from "./servicecue-body";
import { ServiceCuePlanNav } from "./servicecue-plan-nav";
import { PAGE_TEXT_SIZE_KEY } from "./servicecue-text-size";
import { TextSizeControl } from "./servicecue-text-size-control";
import { useTextSize } from "./use-servicecue-text-size";
import { useUpcomingPlans } from "../settings/sections/plan-switcher";
import { useNavigateTo, useSearchParam } from "../lib/use-search-param";
import { useDashboardState } from "./use-dashboard-state";
import { pcoConnected } from "./use-stage-state";
import { invoke } from "../lib/api";
import { useFailedReads } from "../lib/use-failed-reads";
import { useResyncOn } from "../lib/use-resync-on";
import { ALL_COLUMNS_LAYOUT_ID, ALL_COLUMNS_SLUG, slugify, serviceCueUrl } from "./servicecue-index-view";
import type { CategoryRole } from "../../main/types/servicecue-roles.js";

// A standalone ServiceCue rundown page: /servicecue/{type}/{layout}. Both path
// parts are name slugs (e.g. /servicecue/weekend/audio) resolved to ids here, with
// raw ids still accepted for backward-compatible bookmarks. Follows the type's
// live-or-next plan; highlights the live item when this type is running.
//
// `?plan=<id>` browses another plan of the type without touching the app's own
// (see ServiceCuePlanNav); no param = following. `?text=<percent>` sets the
// rundown's text size (see useTextSize).
export function ServiceCuePlan({ serviceTypeParam, layoutParam }: { serviceTypeParam: string; layoutParam: string }) {
  const { state, error: stateError, pcoLive } = useDashboardState();
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const [rundown, setRundown] = useState<ServiceCueRundownDTO | null>(null);
  const [layouts, setLayouts] = useState<ServiceCueLayout[]>([]);
  const [roles, setRoles] = useState<CategoryRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Which of the lists FAILED, as opposed to came back empty. Each failure used
  // to draw a plausible page that was wrong; see where they render.
  const { failed, fail, clear } = useFailedReads<"types" | "layouts" | "roles" | "rundown" | "plans" | "plan">("servicecue");
  // The plan this page browses to, kept in the address so a refresh stays put.
  // Null = follow whatever the server resolves for the type.
  const [planParam, setPlanParam] = useSearchParam("plan");
  const [textSize, setTextSize] = useTextSize(PAGE_TEXT_SIZE_KEY);
  const navigateTo = useNavigateTo();

  // The service types and the plan come from Planning Center, so they are asked
  // for only once it is connected (see pcoConnected), and until then the body
  // says why (see notice).
  const pcoConfigured = pcoConnected(state, stateError);
  // A read tried while the state was unknown may have failed only because
  // Planning Center is not connected. Once the state says so, that is the
  // notice, not an error — and a plan read before it can no longer be followed.
  useResyncOn([pcoConfigured], () => {
    if (pcoConfigured !== false) return;
    clear("types", "rundown");
    setError(null);
    setRundown(null);
  });
  // A 502/429 at boot (Planning Center still waking up, the LAN up before the
  // WAN) used to be permanent: nothing re-ran this effect, since neither
  // `pcoConnected(null, error)` nor `pcoConnected(state, null)` changes once the
  // state itself arrives. Retried on the same slow timer as the rundown below,
  // as servicecue-view.tsx retries its own reads for the identical reason.
  useEffect(() => {
    if (!pcoConfigured) return;
    let cancelled = false;
    const load = () =>
      invoke<ServiceTypeDTO[]>("stage:listServiceTypes")
        .then((t) => {
          if (cancelled) return;
          setTypes(t);
          clear("types");
        })
        .catch((err: unknown) => { if (!cancelled) fail("types", "the service types", err); });
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pcoConfigured, fail, clear]);
  // Same reasoning for the layouts and roles: a transient failure at boot left
  // them empty for the life of the page (see servicecue-view.tsx's comment on this
  // exact shape).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      invoke<ServiceCueLayout[]>("servicecue:listLayouts")
        .then((l) => {
          if (cancelled) return;
          setLayouts(l);
          clear("layouts");
        })
        .catch((err: unknown) => { if (!cancelled) fail("layouts", "the column layouts", err); });
      invoke<CategoryRole[]>("servicecue:listRoles")
        .then((r) => {
          if (cancelled) return;
          setRoles(r);
          clear("roles");
        })
        .catch((err: unknown) => { if (!cancelled) fail("roles", "the category roles", err); });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [fail, clear]);

  // Resolve the service-type slug (or raw id) to an id.
  const serviceType = useMemo(
    () => types.find((t) => t.id === serviceTypeParam) ?? types.find((t) => slugify(t.name) === serviceTypeParam.toLowerCase()) ?? null,
    [types, serviceTypeParam],
  );
  // Use the resolved id, or the raw param if it's numeric (id URL) so we can fetch
  // before the type list arrives; null while a slug is still unresolved.
  const resolvedTypeId = serviceType?.id ?? (/^\d+$/.test(serviceTypeParam) ? serviceTypeParam : null);
  // Without the plan the body would spin for ever, so it says why instead:
  // quietly when Planning Center is simply not connected, as an error when a
  // read failed. A slug also needs the type list to resolve.
  const notice = pcoConfigured === false ? "Planning Center isn't connected, so this page can't find its plan." : null;
  const bodyError =
    error ?? (!resolvedTypeId && failed.has("types") ? "Couldn't load the service types, so this page can't find its plan." : null);

  // Dropped in the same render the resolved type changes (a different slug in
  // the URL, or the type list finishing a slug's resolution) — not just on a
  // FAILED read for the new one. Left in place, a stale rundown drew as though
  // it were current: `showError` (servicecue-body.tsx) only fires when there
  // is no rundown to fall back on, so the previous type's plan stayed on
  // screen with nothing to say it no longer matched the URL. A poll that
  // refetches the SAME type never runs this, so a failed retry still keeps
  // the last good rundown exactly as intended below.
  //
  // The browsed plan is part of the same key, for the same reason: stepping to
  // another plan must not leave the last one drawn under the new one's name.
  useResyncOn([resolvedTypeId, planParam], () => {
    setRundown(null);
    setError(null);
    clear("rundown", "plan");
  });

  // Rundown items change rarely; refetch on a slow timer. Live position arrives
  // separately via the SSE-backed dashboard state (pcoLive). A failure keeps the
  // last good rundown on screen (see ServiceCueBody) and is logged once.
  useEffect(() => {
    if (!resolvedTypeId || !pcoConfigured) return;
    let cancelled = false;
    const load = () =>
      invoke<ServiceCueRundownDTO>("servicecue:rundown", { serviceTypeId: resolvedTypeId, ...(planParam ? { planId: planParam } : {}) })
        .then((r) => {
          if (cancelled) return;
          clear("rundown");
          // The server answers an unknown plan with an empty rundown rather than
          // an error. Drawn as a rundown it would read as a plan with no items;
          // a plan the operator asked for by id and did not get is said so, and
          // logged, since a pasted link is how it happens.
          if (planParam && r.planId === null) {
            setRundown(null);
            setError("That plan isn't one of this service type's plans.");
            fail("plan", `plan ${planParam} under service type ${resolvedTypeId}`, new Error("not among this service type's plans"));
            return;
          }
          clear("plan");
          setRundown(r);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(errorMessage(e));
          fail("rundown", `the rundown for service type ${resolvedTypeId}`, e);
        });
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [resolvedTypeId, planParam, pcoConfigured, fail, clear]);

  // The plans the switcher walks: the slots editor's own list, asked for only
  // once Planning Center is connected.
  const upcoming = useUpcomingPlans({ enabled: !!pcoConfigured });
  // The read failed (an Error), or answered that Planning Center could not be
  // reached (a string). Neither is an empty list, and each is said and logged.
  const planListProblem = upcoming.error ?? upcoming.unavailable;
  useEffect(() => {
    if (planListProblem) fail("plans", "the plan list", planListProblem);
    else clear("plans");
  }, [planListProblem, fail, clear]);

  const now = useServerClock(pcoLive?.serverNow);

  const allLayouts = useMemo(() => [...layouts].sort((a, b) => a.order - b.order), [layouts]);
  // Resolve the layout slug (or raw id) to a layout; the All-columns slug/id → null.
  const layout = layoutParam === ALL_COLUMNS_SLUG || layoutParam === ALL_COLUMNS_LAYOUT_ID
    ? null
    : allLayouts.find((l) => l.id === layoutParam) ?? allLayouts.find((l) => slugify(l.name) === layoutParam.toLowerCase()) ?? null;
  const layoutName = layout?.name ?? "All columns";
  const currentLayoutKey = layout?.id ?? ALL_COLUMNS_LAYOUT_ID;
  const typeNameForUrl = serviceType?.name ?? serviceTypeParam;

  useEffect(() => {
    const t = rundown?.planTitle ?? rundown?.planSeriesTitle ?? "ServiceCue";
    document.title = `${t} · ${layoutName}`;
  }, [rundown?.planTitle, rundown?.planSeriesTitle, layoutName]);

  // Every derived value comes from the shared hook, so this page and the layout
  // object cannot compute one of them differently — see servicecue-body.tsx.
  const render = useServiceCueRender(rundown, layout, roles, pcoLive, now);

  // Following = no plan chosen, or the chosen plan IS the one the server would
  // resolve with no choice (the server says so; see isDefaultPlan). While a
  // browsed plan loads, or when it never resolves, it reads as Browsing.
  const following = !planParam || rundown?.isDefaultPlan === true;
  // The plan the page would follow, for marking it in the menu: known from the
  // rundown when following, else from the list's own flag for the app's plan
  // (set only for the active type, which is the only type that has one).
  const followedPlanId = following
    ? rundown?.planId ?? null
    : upcoming.plans.find((p) => p.serviceTypeId === resolvedTypeId && p.isCurrent)?.planId ?? null;

  return (
    // FULL BLEED, like a console. The shell's content column keeps its
    // horizontal gutter on every page, chromeless or not, and a console cancels
    // it with negative margins; this does the same. The shell withholds the
    // vertical padding for a full-bleed route (isFullBleedPath), because a
    // negative TOP margin on an h-full box moves it without resizing it.
    //
    // Chromeless since isSharedChromelessPath named this route: no rail and no
    // context bar, so h-full is the whole window.
    <div className="flex flex-col h-full overflow-hidden kiosk-surface -mx-5 max-sm:-mx-3 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* The bar and the rundown are shared with the ServiceCue view-kind and the
          layout object; only the two navigation slots are this page's own. */}
      <ServiceCueHeader
        rundown={rundown}
        render={render}
        appLogo={state?.appLogo}
        appLogoMonochrome={state?.appLogoMonochrome}
        now={now}
        afterIdentity={
          resolvedTypeId && pcoConfigured ? (
            <ServiceCuePlanNav
              serviceTypeId={resolvedTypeId}
              serviceTypeName={serviceType?.name ?? null}
              plans={upcoming.plans}
              plansLoaded={upcoming.loaded}
              currentPlanId={planParam ?? rundown?.planId ?? null}
              followedPlanId={followedPlanId}
              following={following}
              fallbackLabel={[rundown?.planTitle ?? rundown?.planSeriesTitle, rundown?.planDates].filter(Boolean).join(" · ") || null}
              timeZone={rundown?.timeZone ?? state?.timezone ?? null}
              onSelect={(id) => setPlanParam(id)}
              onOpenElsewhere={(typeId, typeName, planId) =>
                navigateTo(serviceCueUrl(typeName ?? typeId, currentLayoutKey, layout?.name), { plan: planId })
              }
            />
          ) : null
        }
        nav={
          <Tooltip label="All services">
            <a href="/servicecue" className="flex items-center justify-center rounded-lg size-8 shrink-0 transition-colors hover:bg-white/10" aria-label="All services">
              <ArrowLeftIcon className="size-4 text-fg-muted" />
            </a>
          </Tooltip>
        }
        trailing={
          <>
          <Tooltip label="Layout">
            <select
              value={currentLayoutKey}
              onChange={(e) => {
                const id = e.target.value;
                // Through the router, keeping the query: ?plan= is the plan this page
                // is browsing, ?text= its size and ?transport= how a panel hears the
                // server, and a layout change is not a reason to drop any of them.
                navigateTo(serviceCueUrl(typeNameForUrl, id, allLayouts.find((l) => l.id === id)?.name), {}, { keepSearch: true });
              }}
              className="rounded-lg border border-line bg-black/30 px-3 py-1.5 text-caption1 text-fg outline-none focus:border-line-strong" aria-label="Layout">
              {allLayouts.map((l) => <option key={l.id} value={l.id} className="bg-[var(--kiosk-surface-1)]">{l.name}</option>)}
              <option value={ALL_COLUMNS_LAYOUT_ID} className="bg-[var(--kiosk-surface-1)]">All columns</option>
            </select>
          </Tooltip>
          <TextSizeControl size={textSize} onChange={setTextSize} />
          </>
        }
      />

      {(failed.has("layouts") || failed.has("roles") || failed.has("plans")) && (
        <div className="flex flex-col gap-1.5 px-4 pt-2">
          {failed.has("layouts") && <ErrorNote>Couldn't load the column layouts, so all columns are shown.</ErrorNote>}
          {failed.has("roles") && <ErrorNote>Couldn't load the category roles, so no note columns are shown.</ErrorNote>}
          {failed.has("plans") && <ErrorNote>Couldn't load the plan list, so the plan arrows and menu have no plans to offer.</ErrorNote>}
        </div>
      )}

      <ServiceCueBody rundown={rundown} roles={roles} layout={layout} render={render} error={bodyError} notice={notice} textScale={textSize / 100} />
    </div>
  );
}
