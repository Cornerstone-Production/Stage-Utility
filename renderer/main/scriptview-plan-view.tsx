import { useEffect, useMemo, useState } from "react";
import { Loader2Icon, ArrowLeftIcon } from "lucide-react";

import { BrandLogo } from "../components/brand-logo";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { RundownTable } from "./rundown-table";
import { resolveScriptViewSpec, computeClocks, buildScriptViewColumns, totalLengthSec, fmtTotal } from "./scriptview-columns";
import { useDashboardState } from "./use-dashboard-state";
import { invoke } from "../lib/api";
import { ALL_COLUMNS_LAYOUT_ID, ALL_COLUMNS_SLUG, slugify, scriptViewUrl } from "./scriptview-index-view";

function fmtSvcTime(iso: string, timeZone?: string | null): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

// A standalone ScriptView rundown page: /scriptview/{type}/{layout}. Both path
// parts are name slugs (e.g. /scriptview/weekend/audio) resolved to ids here, with
// raw ids still accepted for backward-compatible bookmarks. Follows the type's
// live-or-next plan; highlights the live item when this type is running.
export function ScriptViewPlan({ serviceTypeParam, layoutParam }: { serviceTypeParam: string; layoutParam: string }) {
  const { state, pcoLive } = useDashboardState();
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const [rundown, setRundown] = useState<ScriptViewRundownDTO | null>(null);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ServiceTypeDTO[]>("stage:listServiceTypes").then(setTypes).catch(() => setTypes([]));
    invoke<ScriptViewLayout[]>("scriptview:listLayouts").then(setLayouts).catch(() => setLayouts([]));
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
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
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
  useEffect(() => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  }, [pcoLive?.serverNow]);

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

  const items = useMemo(() => rundown?.items ?? [], [rundown?.items]);
  const spec = useMemo(() => resolveScriptViewSpec(layout, rundown?.noteCategories ?? []), [layout, rundown?.noteCategories]);
  const clocks = useMemo(() => computeClocks(items, rundown?.serviceTimes?.[0]), [items, rundown?.serviceTimes]);
  const columns = useMemo(() => buildScriptViewColumns(spec, clocks, rundown?.timeZone), [spec, clocks, rundown?.timeZone]);

  // Only the app's active plan gets the live feed; a service is actually LIVE only
  // when the PCO controller is on a plan item (preservice countdown ≠ live).
  const isActivePlan = !!rundown?.isActivePlan;
  const liveNow = isActivePlan && pcoLive?.mode === "item";
  const timer = isActivePlan ? computePcoTimer(pcoLive, now, skewMs) : null;
  const over = !!timer?.over;
  const currentItemId = liveNow ? pcoLive?.currentItemId : null;

  const clock = new Date(now);
  const h12 = String(((clock.getHours() + 11) % 12) + 1).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  const ss = String(clock.getSeconds()).padStart(2, "0");
  const ampm = clock.getHours() < 12 ? "AM" : "PM";

  const svcTimes = (rundown?.serviceTimes ?? []).map((t) => fmtSvcTime(t, rundown?.timeZone)).filter(Boolean).join("  ·  ");

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Header: back + brand + plan · layout switcher · countdown · clock */}
      <div className="flex items-center gap-4 px-4 h-14 shrink-0 border-b border-line bg-black/40">
        <a href="/scriptview" className="flex items-center justify-center rounded-lg size-8 shrink-0 transition-colors hover:bg-white/10" title="All services" aria-label="All services">
          <ArrowLeftIcon className="size-4 text-fg-muted" />
        </a>
        <div className="flex items-center gap-2 min-w-0">
          {state?.appLogo && <BrandLogo logo={state.appLogo} monochrome className="size-6 rounded text-fg" />}
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-caption1 font-title text-fg truncate">{rundown?.planSeriesTitle ?? rundown?.planTitle ?? "ScriptView"}</span>
            <span className="text-caption2 text-fg-subtle truncate">
              {[rundown?.planSeriesTitle ? rundown?.planTitle : null, rundown?.planDates, svcTimes || null].filter(Boolean).join("  ·  ")}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4 tabular-nums">
          {liveNow && (
            <span className="flex items-center gap-1.5 text-caption2 font-semibold uppercase tracking-wider text-live-11">
              <span className="size-2 rounded-full bg-live-9" /> Live
            </span>
          )}
          {timer && (
            <div className="flex flex-col items-end leading-none">
              <span className="text-caption2 uppercase tracking-wider text-fg-subtle">{over ? "Over" : timer.mode === "preservice" ? "Starts in" : "Remaining"}</span>
              <span className={`text-title3 font-medium ${over ? "text-red-10" : "text-live-11"}`}>{fmtDuration(timer.seconds)}</span>
            </div>
          )}
          <div className="flex flex-col items-end leading-none">
            <span className="text-caption2 uppercase tracking-wider text-fg-subtle">Clock</span>
            <span className="text-title3 font-medium text-fg">{h12}:{mm}<span className="text-fg-subtle text-[0.7em]">:{ss} {ampm}</span></span>
          </div>
          {/* Layout switcher */}
          <select
            value={currentLayoutKey}
            onChange={(e) => {
              const id = e.target.value;
              window.location.href = scriptViewUrl(typeNameForUrl, id, allLayouts.find((l) => l.id === id)?.name);
            }}
            className="rounded-lg border border-line bg-black/30 px-3 py-1.5 text-caption1 text-fg outline-none focus:border-line-strong"
            title="Layout"
          >
            {allLayouts.map((l) => <option key={l.id} value={l.id} className="bg-[var(--kiosk-surface-1)]">{l.name}</option>)}
            <option value={ALL_COLUMNS_LAYOUT_ID} className="bg-[var(--kiosk-surface-1)]">All columns</option>
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <div className="flex items-center justify-center h-full text-red-10 text-body px-6 text-center">{error}</div>
        ) : !rundown ? (
          <div className="flex items-center justify-center h-full"><Loader2Icon className="size-8 text-gray-7 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-full text-fg-faint text-body">
            {rundown.planId ? "No items in this plan" : "No upcoming plan for this service type"}
          </div>
        ) : (
          <RundownTable
            items={items}
            columns={columns}
            currentItemId={currentItemId}
            accentDepartment={layout?.accentDepartment ?? null}
            itemTypeColors={rundown?.itemTypeColors}
            categoryColors={state?.scriptViewCategoryColors}
            footer={spec.showTotalTime ? <span>{fmtTotal(totalLengthSec(items))} <span className="text-fg-subtle">· total time</span></span> : undefined}
          />
        )}
      </div>
    </div>
  );
}
