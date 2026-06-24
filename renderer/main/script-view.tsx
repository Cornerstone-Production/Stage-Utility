import { useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";

import { BrandLogo } from "../components/brand-logo";
import { QrHint } from "../components/qr-hint";
import { LiveControls } from "./live-controls";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { useDashboardState } from "./use-dashboard-state";
import { usePlanItems } from "./use-plan-items";
import { resolveSplValue, useSplHistory, useSplState } from "./use-spl-state";

interface ScriptViewProps {
  displayId: string;
  showLiveControls: boolean;
}

function fmtLen(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * ScriptViewer dashboard — the full plan rundown (every item + PCO note columns)
 * with a wall clock, the PCO Live countdown, the live SPL, and a per-item max-SPL
 * column. The current live item is highlighted. An optional Prev/Next control row
 * (per-display toggle) drives PCO Services Live.
 */
export function ScriptView({ displayId, showLiveControls }: ScriptViewProps) {
  const { state, isLoading, error, pcoLive } = useDashboardState();
  const plan = usePlanItems();
  const history = useSplHistory();
  const spl = useSplState();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [skewMs, setSkewMs] = useState(0);
  useEffect(() => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  }, [pcoLive?.serverNow]);

  // Auto-scroll the current item into view as the service advances.
  const currentRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [pcoLive?.currentItemId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[100dvh] kiosk-surface">
        <Loader2Icon className="size-8 text-gray-7 animate-spin" />
      </div>
    );
  }
  if (error || !state) {
    return (
      <div className="flex items-center justify-center h-[100dvh] kiosk-surface text-gray-7">
        Could not load script
      </div>
    );
  }

  const display = state.displays?.find((d) => d.id === displayId) ?? null;
  const clock = new Date(now);
  const h12 = String(((clock.getHours() + 11) % 12) + 1).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  const ss = String(clock.getSeconds()).padStart(2, "0");
  const ampm = clock.getHours() < 12 ? "AM" : "PM";

  const timer = computePcoTimer(pcoLive, now, skewMs);
  const over = !!timer?.over;
  const live = resolveSplValue(spl);

  const cats = plan?.noteCategories ?? [];
  const items = plan?.items ?? [];
  const maxByItem = new Map<string, number | null>();
  for (const it of history?.items ?? []) maxByItem.set(it.itemId, it.maxSpl);

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Header: brand + plan · clock · countdown · live SPL */}
      <div className="flex items-center gap-4 px-4 h-14 shrink-0 border-b border-white/10 bg-black/40">
        <div className="flex items-center gap-2 min-w-0">
          {state.appLogo && <BrandLogo logo={state.appLogo} monochrome={state.appLogoMonochrome} className="size-6 rounded" />}
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-caption1 font-title text-white/85 truncate">{state.planSeriesTitle ?? state.appName}</span>
            <span className="text-caption2 text-white/45 truncate">{state.planTitle ?? display?.name ?? "Script"}</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-5 tabular-nums">
          {live && (
            <div className="flex flex-col items-end leading-none">
              <span className="text-caption2 uppercase tracking-wider text-white/40">SPL</span>
              <span className="text-title3 font-medium text-white/90">{Math.round(live.value)} dB</span>
            </div>
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
          {state.showQr && state.remoteUrl && (
            <a href="/settings" target="_blank" rel="noopener noreferrer" className="rounded hover:opacity-70 transition-opacity">
              <QrHint url={state.remoteUrl} compact />
            </a>
          )}
        </div>
      </div>

      {/* Rundown table */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex items-center justify-center h-full text-white/35 text-body">
            {plan ? "No items in this plan" : "Planning Center not configured"}
          </div>
        ) : (
          <table className="w-full border-collapse text-[clamp(0.8rem,1.6vmin,1.1rem)]">
            <thead className="sticky top-0 z-10 bg-[#14161c] text-white/45">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium w-16 text-right">Len</th>
                <th className="px-3 py-2 font-medium">Item</th>
                {cats.map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}
                <th className="px-3 py-2 font-medium w-24 text-right">Max SPL</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                if (it.itemType === "header") {
                  return (
                    <tr key={it.id} className="bg-white/[0.06]">
                      <td colSpan={cats.length + 3} className="px-3 py-1.5 text-caption1 font-semibold uppercase tracking-wider text-white/70">
                        {it.title}
                      </td>
                    </tr>
                  );
                }
                const isCurrent = pcoLive?.currentItemId === it.id;
                const max = maxByItem.get(it.id);
                return (
                  <tr
                    key={it.id}
                    ref={isCurrent ? currentRef : undefined}
                    className={`border-b border-white/5 align-top ${isCurrent ? "bg-[#2dd49618]" : ""}`}
                  >
                    <td className="px-3 py-2 text-right tabular-nums text-white/55">{fmtLen(it.lengthSec)}</td>
                    <td className={`px-3 py-2 font-medium ${isCurrent ? "text-[#7fe3c4]" : "text-white/90"}`}>
                      {it.title}
                    </td>
                    {cats.map((c) => (
                      <td key={c} className="px-3 py-2 text-white/60 whitespace-pre-line">{it.notesByCategory[c] ?? ""}</td>
                    ))}
                    <td className="px-3 py-2 text-right tabular-nums text-white/80">
                      {max != null ? `${Math.round(max)} dB` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showLiveControls && (
        <div className="shrink-0 p-3 border-t border-white/10">
          <LiveControls />
        </div>
      )}
    </div>
  );
}
