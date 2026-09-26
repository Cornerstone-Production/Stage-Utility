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
import { StatStrip, useStoredKeysVersion, type StatFigure } from "./history-chart";

import { SPL_METRICS_STORAGE_KEY, servicePeakLevel, type ServicePeakLevel } from "./spl-history-section";
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
 * "recording", in green, while a record is still open.
 *
 * One component, because History has TWO pages that say it: a service's own
 * page, and the arrival-ramp page a service shows before its first plan item
 * goes live. Those were a green pill and a red `LIVE` badge saying the same
 * thing in two vocabularies.
 *
 * The pulse is the chart's live-edge beat, on opacity — `r` is an SVG geometry
 * property and does nothing on an HTML dot. Dropped outright under reduced
 * motion rather than left to the stylesheet's global collapse, so there is no
 * one-frame flash of it.
 */
export function RecordingPill() {
  return (
    <span
      data-testid="recording-pill"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-live-9/45 bg-live-9/12 px-2 py-0.5 text-[10px] font-semibold text-live-11"
    >
      <RecordingDot />
      recording
    </span>
  );
}

/**
 * The pill's dot, on its own — six pixels that say a record is still open where
 * there is no room for the word.
 *
 * ONE definition, so the dot beside a list row's start time and the dot inside
 * the pill are the same colour and the same beat. Two of them drifting apart is
 * how one surface ends up pulsing and another not.
 *
 * `label` gives it an accessible name where it stands alone; inside the pill the
 * word is already there, so the dot is hidden from a screen reader instead of
 * read twice.
 */
export function RecordingDot({ label }: { label?: string } = {}) {
  const reduced = prefersReducedMotion();
  return (
    <span
      data-testid={label ? "recording-dot" : undefined}
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={cn("inline-block size-1.5 shrink-0 rounded-full bg-live-9", !reduced && "su-history-pulse-dot")}
    />
  );
}

/** What the peak-level figure says when there is no level, per reason. `level`
 *  has no note: the number is the answer. */
const LEVEL_EMPTY_NOTE: Record<ServicePeakLevel["kind"], string | undefined> = {
  level: undefined,
  "no-record": "no sound recorded",
  "no-metrics": "no metrics recorded",
  // Points at the control that fixes it, by the name on screen.
  hidden: "metric hidden in Sound",
  "no-samples": "no peak recorded",
};

/**
 * Figures for a service whose sound record could not be READ.
 *
 * The level says "sound unavailable", the Trends card's words for the same case,
 * never "no sound recorded": that is a claim about the service, and a server
 * that did not answer has made none. The header and the All services row both
 * say it through here.
 */
export function markSoundUnavailable<F extends StatFigure & { sub?: string }>(figures: F[]): F[] {
  return figures.map((f) => (f.key === "level" ? { ...f, sub: "sound unavailable" } : f));
}

/**
 * Everything derived from one recording that a figure about it can be built
 * from — the header's six KPIs and the All services row's four alike.
 *
 * ONE derivation, two presentations. The row used to compute its own late
 * start, its own actual and its own delta-vs-plan; three expressions that were
 * the same on the day they were written and had nothing holding them together
 * afterwards.
 */
function serviceFigureParts(timeline: ServiceTimeline, spl: ServiceSplHistory | null, now?: number) {
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
  return { sum, over, projectedEnd, totalDelta, actualEnd, peakLevel: servicePeakLevel(spl) };
}

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
  return serviceKpisFrom(serviceFigureParts(timeline, spl, now), attendance);
}

/** The formatting half, over parts already derived — so a caller that wants
 *  both the figures and a raw part does not derive everything twice. */
function serviceKpisFrom(
  parts: ReturnType<typeof serviceFigureParts>,
  attendance: ServiceAttendance | null,
): (StatFigure & { sub?: string })[] {
  const { sum, over, projectedEnd, totalDelta, actualEnd, peakLevel } = parts;
  return [
    {
      key: "started",
      label: "Started",
      value: fmtTime(sum.firstStart),
      // A service more than a minute late is the one timing figure worth a
      // colour; anything inside a minute is on time in practice.
      color: sum.lateStartSec != null && sum.lateStartSec > 60 ? "var(--color-warn-11)" : undefined,
      // "on time" rather than "±0:00 late", which is what a service that started
      // exactly on the minute read as. `fmtDelta` spells zero as "±0:00", and
      // the word after it then contradicts the number in front of it. Seen in
      // Chrome on the 3 Sep 20:45 recording.
      sub:
        sum.lateStartSec == null
          ? undefined
          : sum.lateStartSec === 0
            ? "on time"
            : `${fmtDelta(sum.lateStartSec)} ${sum.lateStartSec > 0 ? "late" : "early"}`,
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
       * It took a door count as the value and `peakOccupancy` as "in room", so
       * on the 17 Sep Salt Company recording the header said "Peak attendance
       * 2,061 / 1,196 in room" while the Attendance card directly below it said
       * "PEAK 1,196 / ENTRIES 2,061". Two figures, one page, labelled
       * oppositely.
       *
       * Both figures are the recorder's own stored fields, which is also what
       * the dashboard's people widgets read — so the header, the Attendance
       * card, the pasted report and every layout now quote one number each.
       *
       * "PEAK IN ROOM", the All services row's own words for this same figure,
       * so one number has one name on both pages. "Peak attendance" was true and
       * did not distinguish itself from the door count beside it, which is the
       * pair this comment exists about. The mockup says "peak attendance"; it is
       * superseded on this point, and the spec says so.
       */
      label: "Peak in room",
      value: attendance && attendance.peakOccupancy > 0 ? attendance.peakOccupancy.toLocaleString() : "—",
      sub: attendance ? `${attendance.peakAttendance.toLocaleString()} entries` : undefined,
    },
    {
      key: "level",
      // Named after the metric it actually read, so a church metering LCeq is
      // not told it peaked at an LAeq it never recorded.
      label: peakLevel.kind === "level" ? `Peak ${peakLevel.metric}` : "Peak level",
      value: peakLevel.kind === "level" ? `${Math.round(peakLevel.db)} dB` : "—",
      // WHY there is no level, because only one of these is a fault in the
      // recording. "no metric recorded" used to cover all of them, so an
      // operator who had unticked every metric in Customize was told the
      // service had recorded no sound.
      sub: LEVEL_EMPTY_NOTE[peakLevel.kind],
    },
  ];
}

/**
 * The figures one row of All services carries, and the time it started.
 *
 * Every one of them is PICKED OUT of `serviceKpis` by key rather than derived
 * again, so a row and the page it opens cannot quote different numbers for the
 * same recording. The row shows four of the six: a week read down a column is
 * "how full, how long, how far off, how loud", and Planned and Avg overrun are
 * questions you ask about one service rather than about a month of them.
 *
 * Two presentational differences, and they are the reason this is a function
 * rather than a filter at the call site:
 *
 *   - `Actual` is labelled "Ran", or "Running" while the record is open. The
 *     column heading on a service's own page is the noun; in a list of past
 *     services it reads as a verb.
 *   - versus-plan is its own figure here and a sub-line of Actual there, and it
 *     is DROPPED while the record is open. Half a plan not yet run shows as
 *     "−38:45", which reads as a service running three quarters of an hour
 *     short rather than as one that is three quarters of the way through.
 *
 * `started` comes back separately because it is not a figure in the row — it is
 * the row's own left-hand identity, the time the service began, with its
 * early/late note.
 */
export function serviceRowFigures(
  timeline: ServiceTimeline,
  attendance: ServiceAttendance | null,
  spl: ServiceSplHistory | null,
  now?: number,
): { started: StatFigure & { sub?: string }; figures: (StatFigure & { sub?: string })[] } {
  const live = timeline.endedAt == null;
  const at = live ? now : undefined;
  // ONE derivation. `serviceKpis` calls `serviceFigureParts` itself, and taking
  // the delta from a second call ran `summarize` and `overrunStats` over every
  // item of every row twice for one number that was already in hand.
  const parts = serviceFigureParts(timeline, spl, at);
  const by = new Map(serviceKpisFrom(parts, attendance).map((k) => [k.key, k]));
  const pick = (key: string): StatFigure & { sub?: string } =>
    by.get(key) ?? { key, label: key, value: "—" };
  const { totalDelta } = parts;
  const actual = pick("actual");
  return {
    started: pick("started"),
    figures: [
      { ...pick("attendance"), sub: undefined },
      { ...actual, label: live ? "Running" : "Ran", sub: undefined },
      ...(live || totalDelta == null
        ? []
        : [
          {
            key: "vs-plan",
            label: "vs plan",
            value: fmtDelta(totalDelta),
            // The same rule the header's Avg overrun uses: over is the one
            // direction worth a colour.
            color: totalDelta > 0 ? "var(--color-danger-11)" : undefined,
          },
        ]),
      // The level's `sub` is KEPT. It is the only thing that says WHY there is
      // no number — "no sound recorded", "metric hidden in Sound" — and a row
      // showing a bare "—" sends an operator to look at a meter that is fine.
      pick("level"),
    ],
  };
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
 * How much of the scroller's top the sticky header covers, in px.
 *
 * The header's BOTTOM EDGE measured against the scrolling pane's own top — not
 * its height. The pane carries 16px of padding above its content and a
 * `position: sticky` element inside it pins BELOW that padding, so the header's
 * bottom sits 16px further down than its height says. Reading the height put
 * every scroll target 16px too high: measured in Chrome at 1280, a focused
 * field landed at y=240 against a header bottom of 244. And the padding is
 * conditional (`sm:pt-4`, dropped on a phone and on a full-bleed console), so
 * it cannot be added as a constant either — the same measurement gave 0px of
 * pane padding at 600.
 *
 * Read by the one scrolling pane's `scroll-padding-top` (shell.tsx), which is
 * what pushes ANY scroll target clear: an anchor jump, a focused input in the
 * Edit times table, a find-in-page hit, a `scrollIntoView`. The section cards
 * carry no scroll margin of their own — scroll padding on the scroller already
 * covers them, and both would add up and overshoot by a header's height.
 *
 * jsdom reports every geometry as 0 and could not have caught any of it; a
 * fixed `scroll-mt-40` (160px, against a header 184px tall at 1280 and 220px at
 * 600) shipped here first and parked each card's heading behind the header it
 * had just jumped past.
 */
export const HEADER_INSET_VAR = "--su-history-header-inset";

/**
 * A sticky header's own geometry, measured against the app's one scroller.
 *
 * Two consumers, one measurement: the scrolling pane's `scroll-padding-top`
 * (published as a custom property, because it has to reach an element this
 * hook does not render) and a section nav's `rootMargin` (the return value).
 * Both were fixed numbers first and both were wrong in a real browser — a
 * header's actual height varies by page, content and width (184px tall at
 * 1280 and 220px at 600 for History's own), against a 160px margin and a
 * 150px root inset, so an anchor jump parked a card's heading behind the
 * header and the nav named the wrong section while a different one filled
 * the screen.
 *
 * The INSET is measured against the pane rather than taken as the header's
 * height, because a sticky element in this pane pins below the pane's own top
 * padding. `rootMargin` (this hook's return value) wants the viewport-relative
 * bottom, which is the same edge read against a different origin.
 *
 * A ResizeObserver rather than a one-shot measure: an action group can wrap to
 * a second line on a narrow window, and other content comes and goes with
 * what the header is showing, so the height it settles at is not the one it
 * first renders at.
 *
 * Shared by History's own ServiceHeader and the Baptisms tab's BaptismHeader
 * — the same sticky-header-over-one-scroller problem, so a second,
 * differently-behaving fix here would only teach an operator that "sections
 * of a page" work differently on two tabs for no reason.
 *
 * jsdom reports every geometry as 0 and could not have caught any of this —
 * driven in a real browser instead, on both tabs that use it.
 */
export function useHeaderInset(ref: React.RefObject<HTMLElement | null>): number {
  const [bottom, setBottom] = useState(150);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const write = () => {
      const r = el.getBoundingClientRect();
      // The app's one scroller, by the name the router knows it by.
      const pane = el.closest<HTMLElement>("[data-scroll-restoration-id]");
      const paneTop = pane ? pane.getBoundingClientRect().top : 0;
      root.style.setProperty(HEADER_INSET_VAR, `${Math.max(0, Math.round(r.bottom - paneTop))}px`);
      setBottom(Math.round(r.bottom));
    };
    write();
    const drop = () => {
      // Leaving a stale inset behind would push the NEXT page's scroll targets
      // down by the height of a header no longer on screen.
      root.style.removeProperty(HEADER_INSET_VAR);
    };
    if (typeof ResizeObserver === "undefined") return drop;
    const obs = new ResizeObserver(write);
    obs.observe(el);
    return () => {
      obs.disconnect();
      drop();
    };
    // `ref` is a parameter here (unlike the component-local useRef() this
    // effect used to close over before the extraction), so exhaustive-deps
    // cannot assume it is stable the way it does a hook's own useRef() — it
    // is, for both of this hook's callers, so this changes nothing at
    // runtime, only what the linter can see.
  }, [ref]);
  return bottom;
}

export interface ServiceHeaderProps {
  timeline: ServiceTimeline;
  attendance: ServiceAttendance | null;
  spl: ServiceSplHistory | null;
  /** The sound record could not be read. Its absence then means nothing about
   *  the service, so the level figure must not say "no sound recorded". */
  soundUnavailable?: boolean;
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
  /** The nav's own list — SERVICE_SECTIONS by default. The caller passes a
   *  longer one for a service the Baptisms card applies to: the header must
   *  not hold a second, competing const of its own, since the two could
   *  drift on which sections exist at all. */
  sections?: readonly { id: string; label: string }[];
}

export function ServiceHeader({
  timeline,
  attendance,
  spl,
  soundUnavailable = false,
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
  sections = SERVICE_SECTIONS,
}: ServiceHeaderProps) {
  const live = timeline.endedAt == null;
  // `serviceKpis` reads the Smaart metric selection through `servicePeakLevel`,
  // and that selection is owned by the Sound card's Customize — a different
  // component, whose write React knows nothing about. Without this in the
  // dependency list the memo held, and switching metric relabelled the card
  // while the header went on quoting the old metric's level.
  const metricsVersion = useStoredKeysVersion(SPL_METRICS_STORAGE_KEY);
  const kpis = useMemo(
    () => {
      // Read so the dependency is a real one and not "unnecessary" to the
      // linter: the value is never used, the CHANGE is the whole point.
      void metricsVersion;
      const figures = serviceKpis(timeline, attendance, spl, live ? now : undefined);
      return soundUnavailable && !spl ? markSoundUnavailable(figures) : figures;
    },
    [timeline, attendance, spl, soundUnavailable, live, now, metricsVersion],
  );

  // Geometry: see useHeaderInset's own doc comment — 184px tall at 1280 and
  // 220px at 600 for THIS header specifically, against a fixed 160px margin
  // and 150px root inset that both shipped first and were both wrong (an
  // anchor jump parked a card's heading behind the header, and the nav named
  // Attendance while Sound filled the screen).
  const ref = useRef<HTMLElement | null>(null);
  const bottom = useHeaderInset(ref);
  const active = useSectionNav(sections.map((s) => s.id), bottom);

  return (
    <header
      ref={ref}
      data-testid="history-service-header"
      className={cn(
        // The app has exactly one scroller — the shell's <main> — and this is
        // rendered directly inside it, so `sticky top-0` pins to the top of the
        // pane, immediately under the context bar.
        "@container sticky top-0 z-20 -mx-1 flex flex-col gap-3 bg-bg px-1 pb-2 pt-1",
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

      {/* Title beside the actions once the HEADER has room for both, not the
          viewport: beside the rail at 640px the actions would not shrink and
          scrolled the page sideways. */}
      <div className="flex flex-col gap-3 @min-[44rem]:flex-row @min-[44rem]:items-start @min-[44rem]:justify-between">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-title3 font-semibold text-fg">
            {timeline.planTitle ?? timeline.serviceKey}
          </span>
          <span className="flex items-center gap-2 text-caption1 text-fg-muted">
            <span className="truncate">{meta}</span>
            {live && <RecordingPill />}
          </span>
        </div>

        {/* One group, in the order an operator reaches for them, with Delete
            pushed past a hairline because it is the one that cannot be undone. */}
        <div data-testid="history-actions" className="flex flex-wrap items-center gap-2 @min-[44rem]:shrink-0">
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
              tooltip="Recompute timing, sound and attendance from the raw rows, and merge in this service's baptism sessions — your per-item time corrections are kept"
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
        {sections.map((s) => (
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
