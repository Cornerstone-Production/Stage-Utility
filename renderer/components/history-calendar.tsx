import { useEffect, useMemo, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

/** A month calendar for browsing recorded services: days with recordings get a
 *  filled dot (shaded by count), click to jump; arrows page month-to-month. Suits
 *  sparse weekly data far better than a year-long contribution grid — a few marked
 *  Sundays in a familiar month grid reads as intentional. `counts` maps a local
 *  "YYYY-MM-DD" to that day's record count. */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function HistoryCalendar({
  counts,
  intensity,
  selected,
  onPick,
}: {
  counts: Map<string, number>;
  /** Per-day attendance intensity 0..1 for the heatmap tint (optional). */
  intensity?: Map<string, number>;
  selected: string | null;
  onPick: (date: string) => void;
}) {
  const today = useMemo(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth(), str: ymd(d.getFullYear(), d.getMonth(), d.getDate()) };
  }, []);

  // Displayed month — follows the selected day; defaults to today.
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    if (selected) {
      const p = new Date(`${selected}T00:00:00`);
      if (!Number.isNaN(p.getTime())) return { y: p.getFullYear(), m: p.getMonth() };
    }
    return today;
  });
  useEffect(() => {
    if (!selected) return;
    const p = new Date(`${selected}T00:00:00`);
    if (!Number.isNaN(p.getTime())) setView({ y: p.getFullYear(), m: p.getMonth() });
  }, [selected]);

  // Bound navigation to [earliest recorded month … current month].
  const earliest = useMemo(() => {
    let min: { y: number; m: number } | null = null;
    for (const key of counts.keys()) {
      const [y, m] = key.split("-").map(Number);
      if (!Number.isFinite(y) || !Number.isFinite(m)) continue;
      const cand = { y, m: m - 1 };
      if (!min || cand.y < min.y || (cand.y === min.y && cand.m < min.m)) min = cand;
    }
    return min ?? today;
  }, [counts, today]);

  const idx = (v: { y: number; m: number }) => v.y * 12 + v.m;
  const canPrev = idx(view) > idx(earliest);
  const canNext = idx(view) < idx(today);
  const step = (delta: number) => {
    const n = idx(view) + delta;
    setView({ y: Math.floor(n / 12), m: ((n % 12) + 12) % 12 });
  };

  const firstDow = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const hasHeat = !!intensity && intensity.size > 0;

  return (
    <div className="su-card w-full p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          className="rounded-md p-1 text-fg-subtle transition-colors enabled:hover:bg-fill enabled:hover:text-fg disabled:opacity-30"
          disabled={!canPrev}
          onClick={() => step(-1)}
          aria-label="Previous month"
        >
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className="text-footnote font-semibold text-fg tabular-nums">
          {MONTHS[view.m]} {view.y}
        </span>
        <button
          className="rounded-md p-1 text-fg-subtle transition-colors enabled:hover:bg-fill enabled:hover:text-fg disabled:opacity-30"
          disabled={!canNext}
          onClick={() => step(1)}
          aria-label="Next month"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {DOW.map((d) => (
          <div key={d} className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">{d}</div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={`b${i}`} />;
          const dateStr = ymd(view.y, view.m, d);
          const count = counts.get(dateStr) ?? 0;
          const hasData = count > 0;
          const isSel = selected === dateStr;
          const isToday = today.str === dateStr;
          // Heatmap: service days carry an accent tint scaled by attendance —
          // min 14% so any service day is visible, fuller days darker.
          const heatPct = hasData ? 14 + Math.round((intensity?.get(dateStr) ?? 0) * 44) : 0;
          const style =
            hasData && !isSel
              ? { backgroundColor: `color-mix(in srgb, var(--su-accent) ${heatPct}%, transparent)` }
              : undefined;
          return (
            <button
              key={dateStr}
              type="button"
              disabled={!hasData}
              onClick={() => onPick(dateStr)}
              title={hasData ? `${count} service${count === 1 ? "" : "s"}` : undefined}
              style={style}
              className={`flex h-9 w-full items-center justify-center rounded-lg font-mono text-[13px] tabular-nums transition ${
                isSel
                  ? "bg-accent font-medium text-white"
                  : isToday
                    ? "text-fg ring-1 ring-inset ring-line-strong"
                    : hasData
                      ? "text-fg hover:brightness-125"
                      : "cursor-default text-fg-faint"
              }`}
            >
              {d}
            </button>
          );
        })}
      </div>
      {hasHeat && (
        <div className="mt-3 flex items-center gap-1.5 text-[10px] text-fg-subtle">
          <span>Fewer</span>
          {[14, 26, 40, 58].map((p) => (
            <span
              key={p}
              className="h-2.5 w-4 rounded-sm"
              style={{ backgroundColor: `color-mix(in srgb, var(--su-accent) ${p}%, transparent)` }}
            />
          ))}
          <span>More</span>
        </div>
      )}
    </div>
  );
}
