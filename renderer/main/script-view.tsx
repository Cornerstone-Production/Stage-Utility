import { useEffect, useState } from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { Loader2Icon } from "lucide-react";

import { BrandLogo } from "../components/brand-logo";
import { QrHint } from "../components/qr-hint";
import { LiveControls } from "./live-controls";
import { computePcoTimer, fmtDuration } from "./pco-timer";
import { RundownTable, type RundownColumn } from "./rundown-table";
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
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[100dvh] kiosk-surface">
        <Loader2Icon className="size-8 text-fg-subtle animate-spin" />
      </div>
    );
  }
  if (error || !state) {
    return (
      <div className="flex items-center justify-center h-[100dvh] kiosk-surface text-fg-subtle">
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

  const columns: RundownColumn[] = [
    { key: "len", header: "Len", align: "right", width: "4rem", cellClassName: "text-fg-subtle", render: (it) => fmtLen(it.lengthSec) },
    {
      key: "title", header: "Item",
      render: (it, { isCurrent }) => <span className={`font-medium ${isCurrent ? "text-live-11" : "text-fg"}`}>{it.title}</span>,
    },
    ...cats.map((c): RundownColumn => ({
      key: `note:${c}`, header: c, cellClassName: "text-fg-muted whitespace-pre-line",
      render: (it) => it.notesByCategory[c] ?? "",
    })),
    {
      key: "spl", header: "Max SPL", align: "right", width: "6rem", cellClassName: "text-fg",
      render: (it) => { const max = maxByItem.get(it.id); return max != null ? `${Math.round(max)} dB` : "—"; },
    },
  ];

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* Header: brand + plan · clock · countdown · live SPL */}
      <div className="flex items-center gap-4 px-4 h-14 shrink-0 border-b border-line bg-black/40">
        <div className="flex items-center gap-2 min-w-0">
          {state.appLogo && <BrandLogo logo={state.appLogo} monochrome={state.appLogoMonochrome} className="size-6 rounded" />}
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-caption1 font-title text-fg truncate">{state.planSeriesTitle ?? state.appName}</span>
            <span className="text-caption2 text-fg-subtle truncate">{state.planTitle ?? display?.name ?? "Script"}</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-5 tabular-nums">
          {live && (
            <div className="flex flex-col items-end leading-none">
              <span className="text-caption2 uppercase tracking-wider text-fg-subtle">SPL</span>
              <span className="text-title3 font-medium text-fg">{Math.round(live.value)} dB</span>
            </div>
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
          <div className="flex items-center justify-center h-full text-fg-faint text-body">
            {plan ? "No items in this plan" : "Planning Center not configured"}
          </div>
        ) : (
          <RundownTable items={items} columns={columns} currentItemId={pcoLive?.currentItemId} />
        )}
      </div>

      {showLiveControls && (
        <div className="shrink-0 p-3 border-t border-line">
          <LiveControls />
        </div>
      )}
    </div>
  );
}
