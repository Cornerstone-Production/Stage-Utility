// calendar-view.tsx — a month of Planning Center Calendar events.
//
// TWO COMPONENTS ON PURPOSE. `CalendarMonth` is pure: it is handed a grid and an
// instant and draws them. `CalendarView` is the thin wrapper that fetches and
// ticks. The split is what makes the grid testable — ES-module mocking is not
// enabled in this repo, so a component that called the hook itself could not be
// rendered in a test at all.
//
// NO BUCKETING HAPPENS HERE. Which calendar day an instant falls on is a
// question only the app time zone can answer, and that zone is a SERVER SETTING
// the browser cannot ask for. So the server sends days, and the zone it used —
// and this file then reasons in that zone with the very same helpers the server
// bucketed with, so the two cannot come to disagree by a day. A laptop set to
// another zone would otherwise draw a correct grid with the wrong times on it.
// See main/services/calendar-grid.ts.
//
// THIS IS AN OFFICE DISPLAY, read from a desk, not a stage display read from
// thirty feet. Six rows of squares each holding several events cannot carry
// stage-sized type and there is no version of this that can. The sizes below are
// deliberately smaller and denser than the kiosk norm; they are not an oversight
// waiting to be "fixed" up to stage sizes.

import { useCallback, useEffect, useState } from "react";
import { AlertCircleIcon, CalendarDaysIcon, Loader2Icon } from "lucide-react";

import { invoke } from "../lib/api";
import { formatClock } from "../lib/clock-format";
import { cn } from "../lib/cn";
import { contrastRatio, formatColor, parseColor } from "../components/ui/color-math";
import { zonedDateKey } from "@main/services/app-timezone";
import type { CalendarDay, CalendarEventDTO, CalendarGrid } from "@main/types/calendar";

/** Sunday first, matching the grid the server builds. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The kiosk backdrop, from --kiosk-bg in styles.css.
 *
 * A literal rather than a computed style, and safe as one: .kiosk-surface pins
 * this value in BOTH themes on purpose (a light-theme preview of a kiosk once
 * drew near-black text on near-black, measured at 1.14:1), so there is no second
 * value for it to drift from. It is here because a tag colour has to be checked
 * for contrast against something, and reading it back out of the DOM would make
 * the contrast floor untestable without a browser.
 */
export const KIOSK_BACKDROP = "#0a0a0a";

/** WCAG's floor for a non-text indicator. A tag swatch is exactly that. */
const MIN_CONTRAST = 3;

/**
 * How many events a square draws before it starts counting instead.
 *
 * Four at six rows on a 1080-tall screen. Filtering, not truncation, is the real
 * answer to a busy month — one department's tag took the busiest observed day
 * from thirteen events to three — but an unfiltered calendar still has to say
 * something honest about the twelve it is not showing.
 */
const MAX_EVENTS_PER_DAY = 4;

// ── colour ───────────────────────────────────────────────────────────────────

/**
 * A tag's colour, raised to a contrast floor against the kiosk backdrop.
 *
 * The colours come from the ORGANISATION'S own Calendar. Nothing constrains
 * them, and the real data contains both near-white and near-black — the latter
 * is a swatch that simply is not there on a near-black backdrop.
 *
 * Two things this deliberately does NOT do:
 *
 * - It does not normalise the palette. Several of these tags are lavender. The
 *   no-purple rule is about the app's own chrome; this is somebody's data and
 *   recolouring it would make the wall disagree with Planning Center.
 * - It does not touch a colour that already reads. Nudging a colour that was
 *   fine is a change nobody asked for and a mismatch with the source.
 *
 * @returns the colour to paint, or null when the event carries no tag colour.
 */
export function readableTagColor(hex: string | null): string | null {
  if (!hex) return null;
  let c = parseColor(hex);
  if (!c) return null;
  if (contrastRatio(hex, KIOSK_BACKDROP) >= MIN_CONTRAST) return hex;

  // Lighten toward white, because the backdrop is near-black: there is nowhere
  // darker to go. Steps rather than a solved blend so the hue survives — a
  // solved one lands on grey for a colour that started very dark.
  for (let i = 0; i < 24 && contrastRatio(formatColor(c), KIOSK_BACKDROP) < MIN_CONTRAST; i++) {
    c = { r: c.r + (255 - c.r) * 0.15, g: c.g + (255 - c.g) * 0.15, b: c.b + (255 - c.b) * 0.15, a: 1 };
  }
  return formatColor(c);
}

// ── what a square shows ──────────────────────────────────────────────────────

/**
 * Split a day's events into the ones drawn and the number counted.
 *
 * Never leaves exactly one hidden: spending the last row on "+1 more" instead of
 * the event itself tells the operator strictly less in the same space.
 */
export function visibleEvents(events: readonly CalendarEventDTO[]): {
  shown: CalendarEventDTO[];
  hidden: number;
} {
  if (events.length <= MAX_EVENTS_PER_DAY) return { shown: [...events], hidden: 0 };
  const shown = events.slice(0, MAX_EVENTS_PER_DAY - 1);
  return { shown, hidden: events.length - shown.length };
}

// ── zone-aware formatting ────────────────────────────────────────────────────

// Both of these come from the app's own helpers rather than a local Intl call.
//
// zonedDateKey is the SAME function the server bucketed the squares with, so
// "which square is today" is answered exactly as "which square is this event on"
// was — a second implementation is how the two would come to disagree by a day.
// It is importable here because it is pure and takes its zone explicitly; what
// the renderer cannot do is ASK for the app's zone, which is why the grid
// carries it.
//
// formatClock is the app's one display clock, and it reads the operator's
// 12h/24h setting. A local Intl call here hardcoded 12h, so a 24h install got
// 19:30 everywhere else and 7:30 PM on the calendar.

/**
 * The one event to mark as running, or null.
 *
 * ONE, even when several overlap — overlapping bookings are normal here (a room,
 * a van, and the meeting that reserved both), and two highlights read as a bug.
 * The latest to have started wins, which is the one an operator glancing at the
 * wall means by "what is on right now".
 *
 * All-day events are excluded. One is in progress every minute of its run, so
 * marking it would leave the highlight permanently lit and saying nothing.
 */
function runningEventId(day: CalendarDay | undefined, nowMs: number): string | null {
  let best: { id: string; startedAt: number } | null = null;
  for (const e of day?.events ?? []) {
    if (e.allDay) continue;
    const start = Date.parse(e.startsAt);
    const end = Date.parse(e.endsAt);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (nowMs < start || nowMs > end) continue;
    if (!best || start > best.startedAt || (start === best.startedAt && e.id < best.id)) {
      best = { id: e.id, startedAt: start };
    }
  }
  return best?.id ?? null;
}

// ── the grid ─────────────────────────────────────────────────────────────────

function EventRow({
  event,
  zone,
  running,
}: {
  event: CalendarEventDTO;
  zone: string;
  running: boolean;
}) {
  const color = readableTagColor(event.tags[0]?.color ?? null);
  return (
    <li
      // "true", not "date": the date belongs to the square. This says which of
      // the things on the wall is happening at this moment.
      aria-current={running ? "true" : undefined}
      // bg-fill-active and ring-accent, both of which are real tokens. The first
      // draft said bg-fill-strong, which is not one — Tailwind emits nothing for
      // an undefined colour, so the highlight was a font-weight change and
      // nothing else, and every test still passed because they assert
      // aria-current. It took loading the page to see there was no pill.
      className={cn(
        "flex items-baseline gap-1 rounded px-1 leading-tight truncate",
        running ? "bg-fill-active text-fg font-medium ring-1 ring-accent" : "text-fg-subtle",
      )}
      title={event.location ? `${event.name} — ${event.location}` : event.name}
    >
      <span
        aria-hidden="true"
        data-tag-color={color ?? undefined}
        className="size-1.5 shrink-0 self-center rounded-full"
        // Inline because the value is the organisation's data, not a token.
        style={{ backgroundColor: color ?? "currentColor", opacity: color ? 1 : 0.35 }}
      />
      {!event.allDay && <span className="shrink-0 tabular-nums opacity-70">{formatClock(event.startsAt, { timeZone: zone })}</span>}
      <span className="truncate">{event.name}</span>
    </li>
  );
}

function DaySquare({
  day,
  zone,
  isToday,
  runningId,
}: {
  day: CalendarDay;
  zone: string;
  isToday: boolean;
  runningId: string | null;
}) {
  const { shown, hidden } = visibleEvents(day.events);
  return (
    <div
      role="gridcell"
      data-date={day.date}
      data-in-month={day.inMonth ? "true" : "false"}
      aria-current={isToday ? "date" : undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-r border-b border-line p-1",
        day.inMonth ? "" : "opacity-40",
      )}
    >
      <span
        className={cn(
          "shrink-0 self-start rounded px-1 text-caption2 tabular-nums leading-none",
          isToday ? "bg-accent text-white font-semibold" : "text-fg-faint",
        )}
      >
        {Number(day.date.slice(8))}
      </span>
      <ul className="flex min-h-0 flex-col gap-px overflow-hidden text-caption2">
        {shown.map((e) => (
          <EventRow key={`${day.date}:${e.id}`} event={e} zone={zone} running={e.id === runningId} />
        ))}
        {hidden > 0 && <li className="px-1 text-caption2 text-fg-faint">{`+${hidden} more`}</li>}
      </ul>
    </div>
  );
}

/**
 * The month, drawn. Pure — everything it needs arrives as a prop.
 *
 * @param nowMs the client's best idea of the current instant, already skew
 *   corrected where the caller has a server clock. Used only to decide which
 *   square is today and which event is running.
 */
export function CalendarMonth({
  grid,
  nowMs,
  pcoConfigured,
  failed = false,
}: {
  grid: CalendarGrid | null;
  nowMs: number;
  /**
   * REQUIRED, with no default, and that is the point.
   *
   * It defaulted to true, and the wrapper below forgot to pass it — so a display
   * routed to a calendar before Planning Center was connected said "Nothing on
   * the calendar this month", which is a different and wrong claim. Every test
   * passed it explicitly and none of them caught it; it took loading the page.
   * A required prop makes the compiler ask every caller.
   */
  pcoConfigured: boolean;
  failed?: boolean;
}) {
  // With no grid there is nothing to draw, so the whole surface says why. With a
  // grid AND a failure the last good month stays up, marked stale in the header
  // below — throwing away a correct month because the NEXT read failed is worse
  // than showing one that is a few minutes old and says so.
  if (!grid) {
    return (
      <Notice spinner={!failed}>
        {failed ? "Could not read the calendar from Planning Center" : "Loading the calendar…"}
      </Notice>
    );
  }

  const todayKey = zonedDateKey(nowMs, grid.zone);
  const runningId = runningEventId(
    grid.days.find((d) => d.date === todayKey),
    nowMs,
  );
  const total = grid.days.reduce((n, d) => n + d.events.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col kiosk-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <CalendarDaysIcon className="size-4 text-fg-subtle" aria-hidden="true" />
        <span className="text-footnote font-title text-fg">{grid.monthLabel}</span>
        {/* The failure wins the slot. An operator looking at a month that has
            stopped updating needs to be told that before anything else, and a
            "nothing this month" on a stale grid is the lie this says instead. */}
        {/* The failure wins the slot. An operator looking at a month that has
            stopped updating needs to be told that before anything else, and a
            "nothing this month" on a stale grid is the lie this says instead. */}
        {failed ? (
          <span className="ml-auto text-caption2 text-warn-11">
            Could not reach Planning Center — showing the last month read
          </span>
        ) : grid.unplaceable > 0 ? (
          // The mapper upstream guarantees an ISO start, so this is a contract
          // breach rather than a routine case — and the whole point of counting
          // it was that the caller SAYS so. Counting it and drawing nothing
          // would be the silent absence this feature is written against.
          <span className="ml-auto text-caption2 text-warn-11">
            {`${grid.unplaceable} event${grid.unplaceable === 1 ? "" : "s"} had no usable time and could not be drawn`}
          </span>
        ) : (
          total === 0 && (
            <span className="ml-auto text-caption2 text-fg-faint">
              {pcoConfigured
                ? "Nothing on the calendar this month"
                : "Planning Center is not connected yet"}
            </span>
          )
        )}
      </div>
      <div className="grid shrink-0 grid-cols-7 border-b border-line">
        {WEEKDAYS.map((d) => (
          <span key={d} className="px-1 py-1 text-center text-caption2 uppercase tracking-wide text-fg-faint">
            {d}
          </span>
        ))}
      </div>
      {/* grid-rows-6 with min-h-0 on the squares: six equal rows that share the
          height they are given, rather than six rows sized by their busiest
          event list and a container that scrolls off a wall nobody can scroll. */}
      <div role="grid" aria-label={grid.monthLabel} className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 border-l border-t border-line">
        {grid.days.map((day) => (
          <DaySquare
            key={day.date}
            day={day}
            zone={grid.zone}
            isToday={day.date === todayKey}
            // Only today's square. A multi-day event is drawn on every square it
            // touches and matching it by id everywhere would put four highlights
            // on the grid for one thing that is running.
            runningId={day.date === todayKey ? runningId : null}
          />
        ))}
      </div>
    </div>
  );
}

/** @param spinner false for a settled state — a spinner over a failure says the
 *  app is still trying, which it is not until the next poll. */
function Notice({ children, spinner }: { children: React.ReactNode; spinner: boolean }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 kiosk-surface text-footnote text-fg-subtle">
      {spinner ? (
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <AlertCircleIcon className="size-4 text-warn-11" aria-hidden="true" />
      )}
      {children}
    </div>
  );
}

// ── the wrapper that fetches ─────────────────────────────────────────────────

/**
 * How often the grid is re-read.
 *
 * Matched to the calendar client's own three-minute cache on event instances, so
 * a display asking more often would only be served the same answer. Several
 * displays share that server-side cache, so the cost is one PCO request every
 * three minutes for the whole building, not one per screen.
 *
 * A poll rather than a pushed channel, unlike the rest of this app. The grid has
 * no event to push from: nothing here observes Planning Center, so a broadcast
 * would need a server-side poller feeding it — the same request on the same
 * timer, with a channel and a subscriber gate around it. It also carries the
 * date rollover for free: the anchor is computed server-side on every read, so
 * the month turns over on its own at local midnight.
 */
const REFRESH_MS = 3 * 60_000;

/** The kiosk route and the layout embed both come through here. */
export function CalendarView({
  viewId,
  pcoConfigured,
  nowMs,
}: {
  viewId: string | null;
  /** From the stage state the caller already holds. Required for the reason
   *  CalendarMonth's copy is. */
  pcoConfigured: boolean;
  nowMs?: number;
}) {
  const [grid, setGrid] = useState<CalendarGrid | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  const load = useCallback(() => {
    return invoke<CalendarGrid>("calendar:getGrid", { viewId }).then(
      (g) => ({ g, ok: true as const }),
      () => ({ g: null, ok: false as const }),
    );
  }, [viewId]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      void load().then(({ g, ok }) => {
        if (cancelled) return;
        // The failure is REPORTED, not swallowed: a calendar that quietly empties
        // itself is the absence nobody reports. The last good grid is kept on
        // screen underneath the notice rather than blanked.
        setFailed(!ok);
        if (g) setGrid(g);
      });
    };
    run();
    const t = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [load]);

  // A minute is enough: the highlight moves between events, and the day rolls
  // over. A one-second tick would re-render the whole grid sixty times as often
  // for a change nobody can see.
  useEffect(() => {
    if (nowMs !== undefined) return;
    const t = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [nowMs]);

  return (
    <CalendarMonth grid={grid} nowMs={nowMs ?? tick} pcoConfigured={pcoConfigured} failed={failed} />
  );
}
