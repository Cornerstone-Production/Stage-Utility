import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "../components/ui/tooltip";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { ArrowLeftIcon } from "lucide-react";

import { ScriptViewBody, ScriptViewHeader, useScriptViewRender } from "./scriptview-body";
import { useDashboardState } from "./use-dashboard-state";
import { invoke } from "../lib/api";
import { ALL_COLUMNS_LAYOUT_ID, ALL_COLUMNS_SLUG, slugify, scriptViewUrl } from "./scriptview-index-view";
import type { CategoryRole } from "../../main/types/scriptview-roles.js";

// A standalone ScriptView rundown page: /scriptview/{type}/{layout}. Both path
// parts are name slugs (e.g. /scriptview/weekend/audio) resolved to ids here, with
// raw ids still accepted for backward-compatible bookmarks. Follows the type's
// live-or-next plan; highlights the live item when this type is running.
export function ScriptViewPlan({ serviceTypeParam, layoutParam }: { serviceTypeParam: string; layoutParam: string }) {
  const { state, pcoLive } = useDashboardState();
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const [rundown, setRundown] = useState<ScriptViewRundownDTO | null>(null);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [roles, setRoles] = useState<CategoryRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ServiceTypeDTO[]>("stage:listServiceTypes").then(setTypes).catch(() => setTypes([]));
    invoke<ScriptViewLayout[]>("scriptview:listLayouts").then(setLayouts).catch(() => setLayouts([]));
    invoke<CategoryRole[]>("scriptview:listRoles").then(setRoles).catch(() => setRoles([]));
  }, []);

  // Resolve the service-type slug (or raw id) to an id.
  const serviceType = useMemo(
    () => types.find((t) => t.id === serviceTypeParam) ?? types.find((t) => slugify(t.name) === serviceTypeParam.toLowerCase()) ?? null,
    [types, serviceTypeParam],
  );
  // Use the resolved id, or the raw param if it's numeric (id URL) so we can fetch
  // before the type list arrives; null while a slug is still unresolved.
  const resolvedTypeId = serviceType?.id ?? (/^\d+$/.test(serviceTypeParam) ? serviceTypeParam : null);

  // Rundown items change rarely; refetch on a slow timer. Live position arrives
  // separately via the SSE-backed dashboard state (pcoLive).
  useEffect(() => {
    if (!resolvedTypeId) return;
    let cancelled = false;
    const load = () =>
      invoke<ScriptViewRundownDTO>("scriptview:rundown", { serviceTypeId: resolvedTypeId })
        .then((r) => { if (!cancelled) { setRundown(r); setError(null); } })
        .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [resolvedTypeId]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [skewMs, setSkewMs] = useState(0);
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

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
  const render = useScriptViewRender(rundown, layout, roles, pcoLive, now, skewMs);

  return (
    // FULL BLEED, like a console. The shell gutters its content, so this kiosk
    // surface rendered as a dark slab inside a light frame: 20px down each side
    // and 16px under the strip. The negative margins take the sides back; the
    // shell withholds the top for a full-bleed route (isFullBleedPath), because
    // a negative TOP margin on an h-full box moves it without resizing it and
    // just puts the band at the bottom instead.
    //
    // h-full, not 100dvh. This lives below the context bar, so asking for the
    // whole viewport made it 60px taller than the space it was given — it
    // overflowed and scrolled by exactly the height of the chrome above it. The
    // display document, which really does own the viewport, is a different
    // entry point.
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

      <ScriptViewBody rundown={rundown} roles={roles} layout={layout} render={render} error={error} />
    </div>
  );
}
