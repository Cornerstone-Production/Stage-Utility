import { useEffect, useMemo, useState } from "react";
import { Loader2Icon, ArrowLeftIcon } from "lucide-react";

import { BrandLogo } from "../components/brand-logo";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { RundownTable } from "./rundown-table";
import { resolveScriptViewSpec, computeClocks, buildScriptViewColumns, totalLengthSec, fmtTotal } from "./scriptview-columns";
import { useDashboardState } from "./use-dashboard-state";
import { invoke } from "../lib/api";
import { ALL_COLUMNS_LAYOUT_ID } from "./scriptview-index-view";

function fmtSvcTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// A standalone ScriptView rundown page: /scriptview/{serviceTypeId}/{layoutId}.
// Follows the service type's live-or-next plan, applies the chosen layout's column
// preset, and highlights the live item when this type is the one running.
export function ScriptViewPlan({ serviceTypeId, layoutId }: { serviceTypeId: string; layoutId: string }) {
  const { state, pcoLive } = useDashboardState();
  const [rundown, setRundown] = useState<ScriptViewRundownDTO | null>(null);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Rundown items change rarely; refetch on a slow timer. Live position arrives
  // separately via the SSE-backed dashboard state (pcoLive).
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      invoke<ScriptViewRundownDTO>("scriptview:rundown", { serviceTypeId })
        .then((r) => { if (!cancelled) { setRundown(r); setError(null); } })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [serviceTypeId]);

  useEffect(() => {
    invoke<ScriptViewLayout[]>("scriptview:listLayouts").then(setLayouts).catch(() => setLayouts([]));
  }, []);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [skewMs, setSkewMs] = useState(0);
  useEffect(() => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  }, [pcoLive?.serverNow]);

  const typeLayouts = useMemo(
    () => layouts.filter((l) => l.serviceTypeId === serviceTypeId).sort((a, b) => a.order - b.order),
    [layouts, serviceTypeId],
  );
  const layout = layoutId === ALL_COLUMNS_LAYOUT_ID ? null : typeLayouts.find((l) => l.id === layoutId) ?? null;
  const layoutName = layout?.name ?? "All columns";

  useEffect(() => {
    const t = rundown?.planTitle ?? rundown?.planSeriesTitle ?? "ScriptView";
    document.title = `${t} · ${layoutName}`;
  }, [rundown?.planTitle, rundown?.planSeriesTitle, layoutName]);

  const items = useMemo(() => rundown?.items ?? [], [rundown?.items]);
  const spec = useMemo(() => resolveScriptViewSpec(layout, rundown?.noteCategories ?? []), [layout, rundown?.noteCategories]);
  const clocks = useMemo(() => computeClocks(items, rundown?.serviceTimes?.[0]), [items, rundown?.serviceTimes]);
  const columns = useMemo(() => buildScriptViewColumns(spec, clocks), [spec, clocks]);

  const timer = rundown?.isLive ? computePcoTimer(pcoLive, now, skewMs) : null;
  const over = !!timer?.over;
  const currentItemId = rundown?.isLive ? pcoLive?.currentItemId : null;

  const clock = new Date(now);
  const h12 = String(((clock.getHours() + 11) % 12) + 1).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  const ss = String(clock.getSeconds()).padStart(2, "0");
  const ampm = clock.getHours() < 12 ? "AM" : "PM";

  const svcTimes = (rundown?.serviceTimes ?? []).map(fmtSvcTime).filter(Boolean).join("  ·  ");

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Header: back + brand + plan · layout switcher · countdown · clock */}
      <div className="flex items-center gap-4 px-4 h-14 shrink-0 border-b border-white/10 bg-black/40">
        <a href="/scriptview" className="flex items-center justify-center rounded-lg size-8 shrink-0 transition-colors hover:bg-white/10" title="All services" aria-label="All services">
          <ArrowLeftIcon className="size-4 text-white/60" />
        </a>
        <div className="flex items-center gap-2 min-w-0">
          {state?.appLogo && <BrandLogo logo={state.appLogo} monochrome={state.appLogoMonochrome} className="size-6 rounded" />}
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-caption1 font-title text-white/85 truncate">{rundown?.planSeriesTitle ?? rundown?.planTitle ?? "ScriptView"}</span>
            <span className="text-caption2 text-white/45 truncate">
              {[rundown?.planSeriesTitle ? rundown?.planTitle : null, rundown?.planDates, svcTimes || null].filter(Boolean).join("  ·  ")}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4 tabular-nums">
          {rundown?.isLive && (
            <span className="flex items-center gap-1.5 text-caption2 font-semibold uppercase tracking-wider text-[#7fe3c4]">
              <span className="size-2 rounded-full bg-[#22c55e]" /> Live
            </span>
          )}
          {timer && (
            <div className="flex flex-col items-end leading-none">
              <span className="text-caption2 uppercase tracking-wider text-white/40">{over ? "Over" : timer.mode === "preservice" ? "Starts in" : "Remaining"}</span>
              <span className={`text-title3 font-medium ${over ? "text-red-10" : "text-[#7fe3c4]"}`}>{fmtDuration(timer.seconds)}</span>
            </div>
          )}
          <div className="flex flex-col items-end leading-none">
            <span className="text-caption2 uppercase tracking-wider text-white/40">Clock</span>
            <span className="text-title3 font-medium text-white/90">{h12}:{mm}<span className="text-white/45 text-[0.7em]">:{ss} {ampm}</span></span>
          </div>
          {/* Layout switcher */}
          <select
            value={layoutId}
            onChange={(e) => { window.location.href = `/scriptview/${encodeURIComponent(serviceTypeId)}/${encodeURIComponent(e.target.value)}`; }}
            className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-caption1 text-white/85 outline-none focus:border-white/25"
            title="Layout"
          >
            {typeLayouts.map((l) => <option key={l.id} value={l.id} className="bg-[#14161c]">{l.name}</option>)}
            <option value={ALL_COLUMNS_LAYOUT_ID} className="bg-[#14161c]">All columns</option>
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <div className="flex items-center justify-center h-full text-red-10 text-body px-6 text-center">{error}</div>
        ) : !rundown ? (
          <div className="flex items-center justify-center h-full"><Loader2Icon className="size-8 text-gray-7 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-full text-white/35 text-body">
            {rundown.planId ? "No items in this plan" : "No upcoming plan for this service type"}
          </div>
        ) : (
          <RundownTable
            items={items}
            columns={columns}
            currentItemId={currentItemId}
            accentDepartment={layout?.accentDepartment ?? null}
            footer={spec.showTotalTime ? <span>{fmtTotal(totalLengthSec(items))} <span className="text-white/40">· total time</span></span> : undefined}
          />
        )}
      </div>
    </div>
  );
}
