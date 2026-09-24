import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { ErrorNote } from "../components/ui/error-note";
import { useServerClock } from "@renderer/lib/server-clock";
import { ArrowLeftIcon } from "lucide-react";

import { ScriptViewBody, ScriptViewHeader, useScriptViewRender } from "./scriptview-body";
import { useDashboardState } from "./use-dashboard-state";
import { pcoConnected } from "./use-stage-state";
import { invoke } from "../lib/api";
import { useFailedReads } from "../lib/use-failed-reads";
import { useResyncOn } from "../lib/use-resync-on";
import { ALL_COLUMNS_LAYOUT_ID, ALL_COLUMNS_SLUG, slugify, scriptViewUrl } from "./scriptview-index-view";
import type { CategoryRole } from "../../main/types/scriptview-roles.js";

// A standalone ScriptView rundown page: /scriptview/{type}/{layout}. Both path
// parts are name slugs (e.g. /scriptview/weekend/audio) resolved to ids here, with
// raw ids still accepted for backward-compatible bookmarks. Follows the type's
// live-or-next plan; highlights the live item when this type is running.
export function ScriptViewPlan({ serviceTypeParam, layoutParam }: { serviceTypeParam: string; layoutParam: string }) {
  const { state, error: stateError, pcoLive } = useDashboardState();
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const [rundown, setRundown] = useState<ScriptViewRundownDTO | null>(null);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [roles, setRoles] = useState<CategoryRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Which of the lists FAILED, as opposed to came back empty. Each failure used
  // to draw a plausible page that was wrong; see where they render.
  const { failed, fail, clear } = useFailedReads<"types" | "layouts" | "roles" | "rundown">("scriptview");

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
  useEffect(() => {
    if (!pcoConfigured) return;
    let cancelled = false;
    invoke<ServiceTypeDTO[]>("stage:listServiceTypes")
      .then((t) => {
        if (cancelled) return;
        setTypes(t);
        clear("types");
      })
      .catch((err: unknown) => { if (!cancelled) fail("types", "the service types", err); });
    return () => { cancelled = true; };
  }, [pcoConfigured, fail, clear]);
  useEffect(() => {
    invoke<ScriptViewLayout[]>("scriptview:listLayouts")
      .then(setLayouts)
      .catch((err: unknown) => fail("layouts", "the column layouts", err));
    invoke<CategoryRole[]>("scriptview:listRoles")
      .then(setRoles)
      .catch((err: unknown) => fail("roles", "the category roles", err));
  }, [fail]);

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

  // Rundown items change rarely; refetch on a slow timer. Live position arrives
  // separately via the SSE-backed dashboard state (pcoLive). A failure keeps the
  // last good rundown on screen (see ScriptViewBody) and is logged once.
  useEffect(() => {
    if (!resolvedTypeId || !pcoConfigured) return;
    let cancelled = false;
    const load = () =>
      invoke<ScriptViewRundownDTO>("scriptview:rundown", { serviceTypeId: resolvedTypeId })
        .then((r) => {
          if (cancelled) return;
          setRundown(r);
          setError(null);
          clear("rundown");
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(errorMessage(e));
          fail("rundown", `the rundown for service type ${resolvedTypeId}`, e);
        });
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [resolvedTypeId, pcoConfigured, fail, clear]);

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
    const t = rundown?.planTitle ?? rundown?.planSeriesTitle ?? "ScriptView";
    document.title = `${t} · ${layoutName}`;
  }, [rundown?.planTitle, rundown?.planSeriesTitle, layoutName]);

  // Every derived value comes from the shared hook, so this page and the layout
  // object cannot compute one of them differently — see scriptview-body.tsx.
  const render = useScriptViewRender(rundown, layout, roles, pcoLive, now);

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
      {/* The bar and the rundown are shared with the script View-kind and the
          layout object; only the two navigation slots are this page's own. */}
      <ScriptViewHeader
        rundown={rundown}
        render={render}
        appLogo={state?.appLogo}
        appLogoMonochrome={state?.appLogoMonochrome}
        now={now}
        nav={
          <Tooltip label="All services">
            <a href="/scriptview" className="flex items-center justify-center rounded-lg size-8 shrink-0 transition-colors hover:bg-white/10" aria-label="All services">
              <ArrowLeftIcon className="size-4 text-fg-muted" />
            </a>
          </Tooltip>
        }
        trailing={
          <Tooltip label="Layout">
            <select
              value={currentLayoutKey}
              onChange={(e) => {
                const id = e.target.value;
                window.location.href = scriptViewUrl(typeNameForUrl, id, allLayouts.find((l) => l.id === id)?.name);
              }}
              className="rounded-lg border border-line bg-black/30 px-3 py-1.5 text-caption1 text-fg outline-none focus:border-line-strong" aria-label="Layout">
              {allLayouts.map((l) => <option key={l.id} value={l.id} className="bg-[var(--kiosk-surface-1)]">{l.name}</option>)}
              <option value={ALL_COLUMNS_LAYOUT_ID} className="bg-[var(--kiosk-surface-1)]">All columns</option>
            </select>
          </Tooltip>
        }
      />

      {(failed.has("layouts") || failed.has("roles")) && (
        <div className="flex flex-col gap-1.5 px-4 pt-2">
          {failed.has("layouts") && <ErrorNote>Couldn't load the column layouts, so all columns are shown.</ErrorNote>}
          {failed.has("roles") && <ErrorNote>Couldn't load the category roles, so no note columns are shown.</ErrorNote>}
        </div>
      )}

      <ScriptViewBody rundown={rundown} roles={roles} layout={layout} render={render} error={bodyError} notice={notice} />
    </div>
  );
}
