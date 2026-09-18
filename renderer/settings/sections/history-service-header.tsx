// history-service-header.tsx — the sticky header of one service's History page.
//
// Everything that identifies the recording and everything you can do to it, in
// one band that stays put while the page scrolls: the crumb back, the plan
// title, one muted line of series/type/date/time, the action group, six KPIs on
// the stat strip's scale, and a nav that highlights the section you are looking
// at.
//
// The KPIs are the page's summary. They replaced four stat tiles that sat above
// the rundown and repeated Started/Planned/Actual/Avg overrun, so the same four
// numbers were on screen twice as soon as the header existed.
//
// NOT unit-tested, because jsdom cannot see it: `position: sticky`, the
// horizontal scroller the KPI row becomes on a phone, and the separator before
// Delete are all stylesheet, and jsdom loads none. Driven in a real browser at
// 1280 and 600 wide, light and dark. What IS tested here is the derivation
// (`serviceKpis`), the recording pill's condition, the destructive action, and
// the nav highlight through a stubbed IntersectionObserver.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClockIcon, CopyIcon, GitMergeIcon, RotateCcwIcon, Trash2Icon, WrenchIcon } from "lucide-react";

import { cn } from "../../lib/cn";
import { prefersReducedMotion } from "../../lib/reduced-motion";
import { Button } from "../../components/ui";
import { StatStrip, type StatFigure } from "./history-chart";
import { servicePeakAttendance } from "./attendance-history-section";
import { servicePeakLevel } from "./spl-history-section";
import { fmtDelta, fmtDur, fmtTime, isCountedItem, summarize } from "./overview-data";

/** Mean per-item over/under (seconds) + how many ran over, for items with both
 *  planned and actual times. Lives here because the "Avg overrun" KPI is its
 *  only reason to exist; the text report imports it back. */
export function overrunStats(tl: ServiceTimeline) {
  const deltas = tl.items
    .filter((it) => isCountedItem(it, tl) && it.plannedLengthSec != null && it.actualDurationSec != null)
    .map((it) => (it.actualDurationSec as number) - (it.plannedLengthSec as number));
  if (!deltas.length) return { avg: null as number | null, over: 0, total: 0 };
  return {
    avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    over: deltas.filter((d) => d > 0).length,
    total: deltas.length,
  };
}

/** The three sections the nav links to, in page order. The ids are real element
 *  ids — the links are anchors, so they work with JavaScript busy and land in
 *  the tab order for free. */
export const SERVICE_SECTIONS = [
  { id: "history-rundown", label: "Rundown" },
  { id: "history-attendance", label: "Attendance" },
  { id: "history-sound", label: "Sound" },
] as const;

/**
 * The six figures in the header row.
 *
 * Pure, and exported, so the formatting is testable without a DOM: the
 * early/late sign and the "3 of 12 over" tail are the two that have to be read
 * correctly at a glance on a Sunday morning.
 *
 * `now` is only consulted while the record is open — `summarize` counts the
 * in-progress item's elapsed time so Actual ticks up live.
 */
export function serviceKpis(
  timeline: ServiceTimeline,
  attendance: ServiceAttendance | null,
  spl: ServiceSplHistory | null,
  now?: number,
): (StatFigure & { sub?: string })[] {
  const sum = summarize(timeline, now);
  const over = overrunStats(timeline);
  const firstStartMs = Date.parse(sum.firstStart);
  const projectedEnd =
    sum.planned != null && Number.isFinite(firstStartMs)
      ? new Date(firstStartMs + sum.planned * 1000).toISOString()
      : null;
  const totalDelta = sum.planned != null ? sum.actual - sum.planned : null;
  // The last COUNTED item's end — the trailing buffer is not when the service
  // ended, and neither is a pre-service item.
  const actualEnd =
    [...timeline.items].reverse().find((it) => isCountedItem(it, timeline) && it.endedAt)?.endedAt ??
    timeline.endedAt ??
    null;
  const peakLevel = servicePeakLevel(spl);
  return [
    {
      key: "started",
      label: "Started",
      value: fmtTime(sum.firstStart),
      // A service more than a minute late is the one timing figure worth a
      // colour; anything inside a minute is on time in practice.
      color: sum.lateStartSec != null && sum.lateStartSec > 60 ? "var(--color-warn-11)" : undefined,
      sub:
        sum.lateStartSec != null
          ? `${fmtDelta(sum.lateStartSec)} ${sum.lateStartSec >= 0 ? "late" : "early"}`
          : undefined,
    },
    {
      key: "planned",
      label: "Planned",
      value: fmtDur(sum.planned),
      sub: projectedEnd ? `ends ${fmtTime(projectedEnd)}` : undefined,
    },
    {
      key: "actual",
      label: "Actual",
      value: fmtDur(sum.actual),
      color: "var(--color-accent)",
      sub:
        [totalDelta != null ? `${fmtDelta(totalDelta)} vs plan` : null, actualEnd ? `ended ${fmtTime(actualEnd)}` : null]
          .filter(Boolean)
          .join(" · ") || undefined,
    },
    {
      key: "overrun",
      label: "Avg overrun",
      value: over.avg != null ? fmtDelta(over.avg) : "—",
      color: over.avg != null && over.avg > 0 ? "var(--color-danger-11)" : undefined,
      sub: over.total ? `${over.over} of ${over.total} over` : undefined,
    },
    {
      key: "attendance",
      /**
       * ATTENDANCE IS PEOPLE IN THE ROOM. Entries is the cumulative door count,
       * which double-counts anyone who steps out and back — the two are
       * different numbers and this had them the wrong way round.
       *
       * It read `servicePeakAttendance` as the value and `peakOccupancy` as
       * "in room", so on the 17 Sep Salt Company recording the header said
       * "Peak attendance 2,061 / 1,196 in room" while the Attendance card
       * directly below it said "PEAK 1,196 / ENTRIES 2,061". Two figures, one
       * page, labelled oppositely.
       *
       * The entries sub reads `servicePeakAttendance`, the SAME derivation the
       * Attendance card's Entries figure uses, so the two cannot drift apart —
       * the card computes it from the samples rather than reading the record's
       * stored `peakAttendance`, and a header quoting the stored field instead
       * would say 1,727 under a card saying 2,061 and reintroduce the fault
       * one line down.
       */
      label: "Peak attendance",
      value: attendance && attendance.peakOccupancy > 0 ? attendance.peakOccupancy.toLocaleString() : "—",
      sub: attendance ? `${servicePeakAttendance(attendance).toLocaleString()} entries` : undefined,
    },
    {
      key: "level",
      // Named after the metric it actually read, so a church metering LCeq is
      // not told it peaked at an LAeq it never recorded.
      label: peakLevel ? `Peak ${peakLevel.metric}` : "Peak level",
      value: peakLevel ? `${Math.round(peakLevel.db)} dB` : "—",
      sub: peakLevel ? undefined : spl ? "no metric recorded" : undefined,
    },
  ];
}

/**
 * Which of `ids` the operator is looking at, from an IntersectionObserver.
 *
 * Ratio-ranked rather than first-hit: three sections of very different heights
 * are often all partly on screen at once, and "the first one intersecting" made
 * the nav sit on Rundown for the whole page.
 *
 * Returns the first id until the observer reports otherwise, and returns it
 * unchanged in an environment with no IntersectionObserver at all — the nav
 * still navigates, it just does not follow.
 */
export function useSectionNav(ids: readonly string[], headerBottom = 150): string {
  const key = ids.join("|");
  const [active, setActive] = useState<string>(ids[0] ?? "");
  useEffect(() => {
    const list = key.split("|").filter(Boolean);
    if (!list.length || typeof IntersectionObserver === "undefined") return;
    const ratios = new Map<string, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        let best = "";
        let bestRatio = 0;
        for (const id of list) {
          const r = ratios.get(id) ?? 0;
          if (r > bestRatio) {
            bestRatio = r;
            best = id;
          }
        }
        if (best) setActive(best);
      },
      // Everything above the header's own bottom edge is covered by it, so it
      // is not what you are looking at. A fixed 150px here chose Attendance
      // while Sound filled the screen on a 600px-wide window, where the header
      // is 220px tall.
      { rootMargin: `-${Math.round(headerBottom)}px 0px -30% 0px`, threshold: [0, 0.05, 0.25, 0.5, 0.75, 1] },
    );
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
    // `ids` is a fresh array on every render; `key` is its content.
  }, [key, headerBottom]);
  return active;
}

/**
 * The custom property a section card's `scroll-margin-top` is read from.
 *
 * The nav's links are real anchors and the header is sticky, so a jump has to
 * be pushed down by the header's OWN height. A fixed `scroll-mt-40` was wrong
 * in a browser at both widths tested — the header is 184px at 1280 and 220px at
 * 600, against 160px of margin — and put each card's heading behind the header
 * it had just jumped past. jsdom reports every height as 0 and could not have
 * caught it.
 */
export const HEADER_HEIGHT_VAR = "--su-history-header-h";

/** `scroll-margin-top` for anything the header's nav jumps to. The fallback is
 *  only ever used before the header has measured itself once. */
export const SECTION_SCROLL_MARGIN = `calc(var(${HEADER_HEIGHT_VAR}, 12rem) + 0.75rem)`;

export interface ServiceHeaderProps {
  timeline: ServiceTimeline;
  attendance: ServiceAttendance | null;
  spl: ServiceSplHistory | null;
  /** Ticks every second while the record is open, so Actual counts up. */
  now?: number;
  readOnly?: boolean;
  /** Muted meta line: series · service type · date · time. Already formatted. */
  meta: string;
  onBack: () => void;
  onEditTimes: () => void;
  onCopyReport: () => void;
  /** Absent when there is no other recording that day to merge into. */
  onMerge?: () => void;
  onRebuild: () => void;
  onDelete: () => void;
  /** Live only — items before now stop counting toward the pacing readout. */
  onResetPacing: () => void;
}

export function ServiceHeader({
  timeline,
  attendance,
  spl,
  now,
  readOnly = false,
  meta,
  onBack,
  onEditTimes,
  onCopyReport,
  onMerge,
  onRebuild,
  onDelete,
  onResetPacing,
}: ServiceHeaderProps) {
  const live = timeline.endedAt == null;
  const kpis = useMemo(() => serviceKpis(timeline, attendance, spl, live ? now : undefined), [timeline, attendance, spl, live, now]);
  const reduced = prefersReducedMotion();

  /**
   * The header's own geometry, measured.
   *
   * Two consumers, one measurement: the cards' `scroll-margin-top` (published
   * as a custom property, because it has to reach elements this component does
   * not render) and the section nav's `rootMargin`. Both were fixed numbers
   * first and both were wrong in a real browser — the header is 184px tall at
   * 1280 and 220px at 600, against a 160px margin and a 150px root inset, so an
   * anchor jump parked a card's heading behind the header and the nav named
   * Attendance while Sound filled the screen. jsdom reports 0 for every height
   * and cannot see either.
   *
   * A ResizeObserver rather than a one-shot measure: the action group wraps to
   * a second line on a narrow window, and the KPI sub-lines come and go with
   * the record, so the height the header settles at is not the one it first
   * renders at.
   */
  const ref = useRef<HTMLElement | null>(null);
  const [bottom, setBottom] = useState(150);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const write = () => {
      const r = el.getBoundingClientRect();
      root.style.setProperty(HEADER_HEIGHT_VAR, `${Math.round(r.height)}px`);
      setBottom(Math.round(r.bottom));
    };
    write();
    const drop = () => {
      // Leaving a stale height behind would push the NEXT page's anchors down
      // by the height of a header no longer on screen.
      root.style.removeProperty(HEADER_HEIGHT_VAR);
    };
    if (typeof ResizeObserver === "undefined") return drop;
    const obs = new ResizeObserver(write);
    obs.observe(el);
    return () => {
      obs.disconnect();
      drop();
    };
  }, []);

  const active = useSectionNav(SERVICE_SECTIONS.map((s) => s.id), bottom);

  return (
    <header
      ref={ref}
      data-testid="history-service-header"
      className={cn(
        // The app has exactly one scroller — the shell's <main> — and this is
        // rendered directly inside it, so `sticky top-0` pins to the top of the
        // pane, immediately under the context bar.
        "sticky top-0 z-20 -mx-1 flex flex-col gap-3 bg-bg px-1 pb-2 pt-1",
        "border-b border-line",
        // The pane carries its own top padding and `sticky top-0` pins BELOW
        // it, leaving a strip the page scrolls through above the header. This
        // paints that strip in the page background. Same trick as the
        // automation list's pinned search bar.
        "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-bg before:content-['']",
      )}
    >
      <button className="self-start text-caption1 text-accent hover:underline" onClick={onBack}>
        ← All services
      </button>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-title3 font-semibold text-fg">
            {timeline.planTitle ?? timeline.serviceKey}
          </span>
          <span className="flex items-center gap-2 text-caption1 text-fg-muted">
            <span className="truncate">{meta}</span>
            {live && (
              <span
                data-testid="recording-pill"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-live-9/45 bg-live-9/12 px-2 py-0.5 text-[10px] font-semibold text-live-11"
              >
                <span
                  aria-hidden="true"
                  className={cn("inline-block size-1.5 rounded-full bg-live-9", !reduced && "su-history-pulse-dot")}
                />
                recording
              </span>
            )}
          </span>
        </div>

        {/* One group, in the order an operator reaches for them, with Delete
            pushed past a hairline because it is the one that cannot be undone. */}
        <div data-testid="history-actions" className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {!readOnly && live && (
            <Button
              variant="filled"
              size="small"
              onClick={onResetPacing}
              tooltip="Stop items before now from counting toward the pacing readout — the recording itself is untouched"
            >
              <RotateCcwIcon className="size-3.5 text-fg-muted" /> Reset pacing
            </Button>
          )}
          {!readOnly && (
            <Button
              variant="filled"
              size="small"
              onClick={onEditTimes}
              tooltip="Fix the recorded start/end (trims samples + items outside the window)"
            >
              <ClockIcon className="size-3.5 text-fg-muted" /> Edit times
            </Button>
          )}
          <Button variant="filled" size="small" onClick={onCopyReport} tooltip="Copy a full text report (timing + attendance + audio)">
            <CopyIcon className="size-3.5 text-fg-muted" /> Copy report
          </Button>
          {!readOnly && onMerge && (
            <Button
              variant="filled"
              size="small"
              onClick={onMerge}
              tooltip="Merge this recording into another service (fixes a split service), then delete this one"
            >
              <GitMergeIcon className="size-3.5 text-fg-muted" /> Merge…
            </Button>
          )}
          {!readOnly && (
            <Button
              variant="filled"
              size="small"
              onClick={onRebuild}
              tooltip="Recompute all three records from the raw rows in the data archive — your per-item time corrections are kept"
            >
              <WrenchIcon className="size-3.5 text-fg-muted" /> Rebuild from raw
            </Button>
          )}
          {!readOnly && (
            <>
              <span aria-hidden="true" className="h-5 w-px bg-line-strong" />
              <Button
                variant="filled"
                size="small"
                onClick={onDelete}
                className="text-danger-11 hover:bg-danger-9/12 active:bg-danger-9/20"
                tooltip="Delete this recording — timings, SPL and attendance"
              >
                <Trash2Icon className="size-3.5" /> Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {/* The strip's own scale, not a second one. `announce` off: these change
          every second while a service records, and a polite live region would
          read all six out on every tick. */}
      <div data-testid="service-kpis" className="max-sm:-mx-1 max-sm:px-1">
        <StatStrip figures={kpis} hover={null} live={null} announce={false} />
      </div>

      <nav aria-label="Sections of this service" className="flex items-center gap-1 text-caption1">
        {SERVICE_SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={active === s.id ? "true" : undefined}
            className={cn(
              "rounded-md px-2 py-1 transition-colors",
              active === s.id ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill hover:text-fg",
            )}
          >
            {s.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
