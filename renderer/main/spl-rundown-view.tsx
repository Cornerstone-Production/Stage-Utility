import { useEffect, useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";

import { BrandLogo } from "../components/brand-logo";
import { useDashboardState } from "./use-dashboard-state";
import { usePlanItems } from "./use-plan-items";
import { resolveSplValue, useSplHistory, useSplState } from "./use-spl-state";

interface SplRundownViewProps {
  displayId: string;
}

function splColor(db: number | null): string {
  if (db == null) return "text-white/30";
  if (db >= 100) return "text-red-10";
  if (db >= 95) return "text-yellow-10";
  return "text-white/85";
}

/**
 * A simple item-by-item SPL list: every plan item with its recorded max SPL,
 * section headers as dividers, the live item highlighted, and the current live
 * SPL in the header.
 */
export function SplRundownView({ displayId }: SplRundownViewProps) {
  const { state, isLoading, error, pcoLive } = useDashboardState();
  const plan = usePlanItems();
  const history = useSplHistory();
  const spl = useSplState();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
        Could not load rundown
      </div>
    );
  }

  const display = state.displays?.find((d) => d.id === displayId) ?? null;
  const clock = new Date(now);
  const h12 = String(((clock.getHours() + 11) % 12) + 1).padStart(2, "0");
  const mm = String(clock.getMinutes()).padStart(2, "0");
  const live = resolveSplValue(spl);

  const items = plan?.items ?? [];
  // Rebuild only when the recorded history changes, not on every 1 Hz clock tick.
  const maxByItem = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const it of history?.items ?? []) m.set(it.itemId, it.maxSpl);
    return m;
  }, [history]);

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden kiosk-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center gap-4 px-4 h-14 shrink-0 border-b border-white/10 bg-black/40">
        <div className="flex items-center gap-2 min-w-0">
          {state.appLogo && <BrandLogo logo={state.appLogo} monochrome={state.appLogoMonochrome} className="size-6 rounded" />}
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-caption1 font-title text-white/85 truncate">{state.planTitle ?? display?.name ?? "SPL Rundown"}</span>
            <span className="text-caption2 text-white/45 truncate">Max SPL per item</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-5 tabular-nums">
          {live && (
            <div className="flex flex-col items-end leading-none">
              <span className="text-caption2 uppercase tracking-wider text-white/40">Live SPL</span>
              <span className="text-title2 font-medium text-white/90">{Math.round(live.value)} dB</span>
            </div>
          )}
          <div className="flex flex-col items-end leading-none">
            <span className="text-caption2 uppercase tracking-wider text-white/40">Clock</span>
            <span className="text-title3 font-medium text-white/90">{h12}:{mm}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-white/5">
        {items.length === 0 ? (
          <div className="flex items-center justify-center h-full text-white/35 text-body">
            {plan ? "No items in this plan" : "Planning Center not configured"}
          </div>
        ) : (
          items.map((it) => {
            if (it.itemType === "header") {
              return (
                <div key={it.id} className="px-4 py-1.5 bg-white/[0.06] text-caption1 font-semibold uppercase tracking-wider text-white/60">
                  {it.title}
                </div>
              );
            }
            const isCurrent = pcoLive?.currentItemId === it.id;
            const max = maxByItem.get(it.id) ?? null;
            return (
              <div key={it.id} className={`flex items-center gap-4 px-4 py-3 ${isCurrent ? "bg-[#2dd49618]" : ""}`}>
                <span className={`flex-1 min-w-0 truncate text-[clamp(1rem,3vmin,1.6rem)] font-medium ${isCurrent ? "text-[#7fe3c4]" : "text-white/85"}`}>
                  {it.title}
                </span>
                <span className={`shrink-0 tabular-nums text-[clamp(1.1rem,3.4vmin,1.9rem)] font-medium ${splColor(max)}`}>
                  {max != null ? `${Math.round(max)} dB` : "—"}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
