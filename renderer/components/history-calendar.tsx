import { useEffect, useMemo, useState } from "react";
import { Tooltip } from "./ui/tooltip";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { serverClock } from "../lib/server-clock";
import { hostTimeZone, zonedDateKey, zonedParts, type TimeZone } from "@main/services/app-timezone";
import { cn } from "../lib/cn";

/** A month calendar for browsing recorded services: a day's cell is SHADED by how
 *  many services were recorded that day, click to jump; arrows page
 *  month-to-month. Suits sparse weekly data far better than a year-long
 *  contribution grid — a few marked Sundays in a familiar month grid reads as
 *  intentional. `counts` maps a local "YYYY-MM-DD" to that day's record count.
 *
 *  The cell carries its DAY NUMBER and nothing else. No dot, no count: a dot
 *  under a number is a second mark saying what the shade already says, and a
 *  count printed in the cell turns a glanceable grid into a table. */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Single letters, the way a month grid is normally headed. Two-letter
 *  abbreviations pushed the cells apart and read as words rather than as a
 *  ruler over the columns. Not a bare array of strings — "T" and "S" each
 *  appear twice, and a duplicate React key on seven siblings is how this
 *  component already lost a month of day cells once. */
const DOW = [
  { key: "sun", label: "S" },
  { key: "mon", label: "M" },
  { key: "tue", label: "T" },
  { key: "wed", label: "W" },
  { key: "thu", label: "T" },
  { key: "fri", label: "F" },
  { key: "sat", label: "S" },
];

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Which of the four shade steps a day's service count lands on.
 *
 * Four steps, because a church runs one to four services on a Sunday and a
 * continuous ramp over that range is four indistinguishable tints. Everything
 * at or above four is the darkest step — a fifth service is not a fifth shade
 * nobody could tell from the fourth.
 *
 * 0 is "no step", not "the lightest step": a day with no recording must read as
 * empty, and a faint tint on every square of the month is noise.
 */
export function shadeStep(count: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(4, Math.round(count)) as 1 | 2 | 3 | 4;
}

/** Mix per step. Step 1 is deliberately visible on its own — one service is the
 *  common case and must not read as an empty day. */
export const SHADE_PCT = [0, 16, 30, 46, 64] as const;

/**
 * GREEN, not the accent.
 *
 * The accent is what a SELECTED day and TODAY are ringed in on this same grid,
 * so shading the fill with it too gave one colour two meanings a cell wide
 * apart: "this many services ran" and "this is the day you are looking at".
 * Green is the colour attendance is already drawn in across the tab.
 */
function shadeStyle(step: number): { backgroundColor: string } | undefined {
  if (step <= 0) return undefined;
  return { backgroundColor: `color-mix(in srgb, var(--color-green-9) ${SHADE_PCT[step]}%, transparent)` };
}

export function HistoryCalendar({
  counts,
  selected,
  onPick,
  onMonthChange,
  zone,
}: {
  counts: Map<string, number>;
  selected: string | null;
  onPick: (date: string) => void;
  /**
   * The month now on screen, as `YYYY-MM`.
   *
   * The list beside this calendar shows that month's services, so which month
   * is displayed is no longer private to this component. Reported on mount as
   * well as on every change, because the opening month is derived here — from
   * the selected day, else today — and the list cannot guess it.
   */
  onMonthChange?: (ym: string) => void;
  /**
   * The zone "today" is answered in — the operator's setting, read from the
   * server, exactly as `appZoneOf` resolves it for Trends. A browser cannot
   * ask for the app's zone, so the caller passes it; this browser's own zone
   * is only the last resort, for the render before that state has arrived.
   */
  zone?: TimeZone;
}) {
  const tz = zone ?? hostTimeZone();
  // The SERVER's clock, not `new Date()`, AND the app's zone, not this
  // browser's: `getFullYear`/`getMonth`/`getDate` read the runtime's own zone,
  // so a browser in a different zone from the server rang the wrong day with
  // no clock skew involved at all — reproduced with a correct, synced server
  // clock and only the browser's zone set to Pacific/Auckland against a
  // server on America/Chicago. Every date this is compared against — the
  // recorded service days it rings and shades, and the month it will not page
  // past — was written by the server, so a console reading its own zone rings
  // a day that is not today and refuses months that exist. Same reading as
  // the PCO calendar's, which calendar-clock.test.tsx already guards; see
  // renderer/lib/server-clock.ts and main/services/app-timezone.ts.
  //
  // Recomputed if `zone` changes — the one render before stage state has
  // arrived falls back to this browser's own zone, and that correction must
  // land — but not on every tick: a calendar that repaints because midnight
  // passed under a stationary cursor is not worth a re-render, and the
  // selected day is the operator's, not the clock's.
  const today = useMemo(() => {
    const now = serverClock.now();
    const p = zonedParts(now, tz);
    return { y: p.year, m: p.month - 1, str: zonedDateKey(now, tz) };
  }, [tz]);

  // Displayed month — follows the selected day; defaults to today.
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    if (selected) {
      const p = new Date(`${selected}T00:00:00`);
      if (!Number.isNaN(p.getTime())) return { y: p.getFullYear(), m: p.getMonth() };
    }
    return today;
  });
  useResyncOn([selected], () => {
    if (!selected) return;
    const p = new Date(`${selected}T00:00:00`);
    if (!Number.isNaN(p.getTime())) setView({ y: p.getFullYear(), m: p.getMonth() });
  });

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

  // Tell the page which month is up — on mount and on every change. An effect
  // rather than a call inside `step`, so the opening month (derived above, from
  // the selection or from today) is reported too; the list beside this
  // calendar cannot derive it for itself.
  const ym = `${view.y}-${String(view.m + 1).padStart(2, "0")}`;
  useEffect(() => {
    onMonthChange?.(ym);
    // `onMonthChange` is a fresh closure on every render of the page above; the
    // month is what this is about, and re-firing on each render would set state
    // up there in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ym]);

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

  return (
    <div className="su-card w-full p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          className="touch-target rounded-md p-1 text-fg-subtle transition-colors enabled:hover:bg-fill enabled:hover:text-fg disabled:opacity-30"
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
          className="touch-target rounded-md p-1 text-fg-subtle transition-colors enabled:hover:bg-fill enabled:hover:text-fg disabled:opacity-30"
          disabled={!canNext}
          onClick={() => step(1)}
          aria-label="Next month"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {DOW.map((d) => (
          <div key={d.key} className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            {d.label}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={`b${i}`} />;
          const dateStr = ymd(view.y, view.m, d);
          const count = counts.get(dateStr) ?? 0;
          const hasData = count > 0;
          const isSel = selected === dateStr;
          const isToday = today.str === dateStr;
          const shade = shadeStep(count);
          return (
            // The key belongs on the element this callback RETURNS — on the
            // inner button it keyed nothing, so React saw a whole month of
            // unkeyed children and was free to reuse the wrong day's DOM on a
            // re-render. It says so in a dev build; the production bundle
            // strips that warning, which is why this was never noticed.
            <Tooltip key={dateStr} label={hasData ? `${count} service${count === 1 ? "" : "s"}` : undefined}>
              <button
                type="button"
                disabled={!hasData}
                onClick={() => onPick(dateStr)}
                style={shadeStyle(shade)}
                // The step is on the element, so a test can assert the shade a
                // count lands on without resolving a `color-mix()` jsdom never
                // computes. It is the same number the style is built from.
                data-date={dateStr}
                data-shade={shade}
                data-today={isToday ? "" : undefined}
                data-selected={isSel ? "" : undefined}
                className={cn(
                  // `justify-center`: the day number is centred in its cell, with
                  // nothing else in it to share the space with.
                  // SQUARE. A fixed 36px row in a column whose width follows the
                  // page gave a grid of landscape cells at 320px and portrait
                  // ones at 240 — the shade is read as an area, and an area
                  // that changes shape with the window is read as two areas.
                  "flex aspect-square w-full items-center justify-center rounded-lg font-mono text-[13px] tabular-nums transition",
                  hasData ? "text-fg" : "cursor-default text-fg-faint",
                  hasData && !isSel && "hover:brightness-125",
                  // Today is OUTLINED in the accent; the selected day carries the
                  // accent ring, heavier, so the two read apart on the day they
                  // coincide. Neither fills the cell — the fill is the shade, and
                  // painting over it would hide the day's service count.
                  isToday && !isSel && "ring-1 ring-inset ring-accent/55",
                  isSel && "font-medium ring-2 ring-inset ring-accent",
                )}
                aria-label={hasData ? `${count} service${count === 1 ? "" : "s"}` : undefined}
              >
                {d}
              </button>
            </Tooltip>
          );
        })}
      </div>
      {/* What the shade MEANS, in a sentence. The four swatches and their
          numbers were a scale nobody reads off a calendar — the question a
          shaded grid raises is "what is the shade", not "which of these four
          is this cell", and a row of tints under a grid of tints is the same
          picture twice. The exact count is on the cell's own tooltip. */}
      <p className="mt-3 text-[10px] text-fg-subtle">
        Shade is how many services ran that day. Today is outlined.
      </p>
    </div>
  );
}
