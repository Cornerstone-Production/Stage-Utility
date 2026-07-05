import { Fragment, useMemo } from "react";

/** GitHub-style contribution grid for service records: one cell per day over a
 *  rolling window, shaded by how many services that day has, click to jump. Gives
 *  an at-a-glance overview of which past dates have data without paging day-by-day.
 *  `counts` maps a local "YYYY-MM-DD" to that day's record count (0/absent = empty). */
export function HistoryCalendar({
  counts,
  selected,
  onPick,
  months = 12,
}: {
  counts: Map<string, number>;
  selected: string | null;
  onPick: (date: string) => void;
  months?: number;
}) {
  const weeks = useMemo(() => {
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setMonth(start.getMonth() - months);
    start.setDate(start.getDate() - start.getDay()); // back to Sunday
    const out: { str: string; count: number; future: boolean; month: number }[][] = [];
    const cur = new Date(start);
    while (cur <= today) {
      const week: { str: string; count: number; future: boolean; month: number }[] = [];
      for (let i = 0; i < 7; i++) {
        const future = cur > today;
        const s = ymd(cur);
        week.push({ str: s, count: counts.get(s) ?? 0, future, month: cur.getMonth() });
        cur.setDate(cur.getDate() + 1);
      }
      out.push(week);
    }
    return out;
  }, [counts, months]);

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Label the column where a month first appears (compared to the prior week).
  const label = (wi: number): string => {
    const m = weeks[wi]?.[0]?.month;
    const prev = wi > 0 ? weeks[wi - 1]?.[0]?.month : -1;
    return m != null && m !== prev ? MONTHS[m] : "";
  };
  const shade = (count: number, future: boolean): string => {
    if (future) return "bg-transparent";
    if (count <= 0) return "bg-gray-a3";
    if (count === 1) return "bg-blue-7";
    if (count === 2) return "bg-blue-9";
    return "bg-blue-11";
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-x-auto pb-1">
        <div
          className="grid w-max"
          style={{ gridAutoFlow: "column", gridTemplateRows: "0.75rem repeat(7, 0.7rem)", gap: "3px" }}
        >
          {weeks.map((week, wi) => (
            <Fragment key={wi}>
              <div className="text-[9px] leading-3 text-gray-9 whitespace-nowrap">{label(wi)}</div>
              {week.map((cell) =>
                cell.future ? (
                  <div key={cell.str} style={{ width: "0.7rem", height: "0.7rem" }} />
                ) : (
                  <button
                    key={cell.str}
                    type="button"
                    disabled={cell.count <= 0}
                    onClick={() => onPick(cell.str)}
                    title={`${cell.str}${cell.count > 0 ? ` — ${cell.count} service${cell.count === 1 ? "" : "s"}` : ""}`}
                    aria-label={`${cell.str}${cell.count > 0 ? `, ${cell.count} services` : ", no services"}`}
                    className={`rounded-[2px] ${shade(cell.count, cell.future)} ${
                      cell.count > 0 ? "cursor-pointer hover:ring-1 hover:ring-blue-8" : "cursor-default"
                    } ${selected === cell.str ? "ring-2 ring-blue-9" : ""}`}
                    style={{ width: "0.7rem", height: "0.7rem" }}
                  />
                ),
              )}
            </Fragment>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-caption2 text-gray-9">
        <span>Less</span>
        <span className="rounded-[2px] bg-gray-a3" style={{ width: "0.7rem", height: "0.7rem" }} />
        <span className="rounded-[2px] bg-blue-7" style={{ width: "0.7rem", height: "0.7rem" }} />
        <span className="rounded-[2px] bg-blue-9" style={{ width: "0.7rem", height: "0.7rem" }} />
        <span className="rounded-[2px] bg-blue-11" style={{ width: "0.7rem", height: "0.7rem" }} />
        <span>More</span>
      </div>
    </div>
  );
}
