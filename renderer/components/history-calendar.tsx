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
  selected,
  onPick,
}: {
  counts: Map<string, number>;
  selected: string | null;
  onPick: (date: string) => void;
}) {
  const today = useMemo(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
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

  const shade = (count: number): string =>
    count >= 3 ? "bg-blue-10 text-white" : count === 2 ? "bg-blue-8 text-white" : "bg-blue-6 text-white";

  return (
    <div className="rounded-lg border border-gray-5 bg-gray-2 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-body font-medium text-gray-12">Recorded services</span>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md p-1 text-gray-11 enabled:hover:bg-gray-4 disabled:opacity-30"
            disabled={!canPrev}
            onClick={() => step(-1)}
            aria-label="Previous month"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <span className="text-caption1 font-medium text-gray-11 tabular-nums w-32 text-center">
            {MONTHS[view.m]} {view.y}
          </span>
          <button
            className="rounded-md p-1 text-gray-11 enabled:hover:bg-gray-4 disabled:opacity-30"
            disabled={!canNext}
            onClick={() => step(1)}
            aria-label="Next month"
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {DOW.map((d) => (
          <div key={d} className="text-caption2 text-gray-9 py-0.5">{d}</div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={`b${i}`} />;
          const dateStr = ymd(view.y, view.m, d);
          const count = counts.get(dateStr) ?? 0;
          const isSel = selected === dateStr;
          const hasData = count > 0;
          return (
            <button
              key={dateStr}
              type="button"
              disabled={!hasData}
              onClick={() => onPick(dateStr)}
              title={hasData ? `${count} service${count === 1 ? "" : "s"}` : undefined}
              className={`aspect-square rounded-md text-caption1 tabular-nums flex items-center justify-center transition-colors ${
                isSel ? "ring-2 ring-blue-9" : ""
              } ${
                hasData
                  ? `${shade(count)} cursor-pointer hover:brightness-110`
                  : "text-gray-8 cursor-default"
              }`}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
