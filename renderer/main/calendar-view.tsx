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

import { useEffect, useMemo, useState } from "react";
import { AlertCircleIcon, CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";

import { invoke, onNotification } from "../lib/api";
import { formatClock } from "../lib/clock-format";
import { cn } from "../lib/cn";
import { contrastRatio, formatColor, parseColor } from "../components/ui/color-math";
import { zonedDateKey } from "@main/services/app-timezone";
import { MAX_MONTH_OFFSET } from "@main/services/calendar-grid";
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
/** The month chevrons' wiring. Supplied only where controls are live. */
export interface CalendarNav {
  /** Months from the current one. 0 is the live, pushed month. */
  offset: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}

/** A chevron. A real <button>, so it is tab-reachable and fires on Enter and
 *  Space without any of that being reimplemented here. */
function NavButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded p-0.5 text-fg-subtle hover:text-fg hover:bg-fill-active disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      {children}
    </button>
  );
}

export function CalendarMonth({
  grid,
  nowMs,
  pcoConfigured,
  failed = false,
  nav = null,
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
  /**
   * The month chevrons, or null for no controls at all.
   *
   * Null on a WALL DISPLAY, which is the point: there is nobody standing at it
   * to press anything, and a control that renders where it cannot be used is
   * furniture. The caller decides, from capabilityLive(ctx, "control") — the
   * app's existing answer to "is this surface operable", rather than a second
   * flag that could disagree with it.
   */
  nav?: CalendarNav | null;
}) {
  // With no grid there is nothing to draw, so the surface says why. With a grid
  // AND a failure the last good month stays up, marked stale in the header below
  // — throwing away a correct month because the NEXT read failed is worse than
  // showing one that is a few minutes old and says so.
  //
  // The CHEVRONS STAY at both. A month the operator paged to arrives a moment
  // after the click, and a full-surface notice in the meantime takes away the
  // controls — including the way back to today — leaving them stranded on a
  // blank screen with nothing to press. A wall display has no chevrons anyway,
  // so it gets the bare notice it always did.
  if (!grid) {
    const body = (
      <Notice spinner={!failed}>
        {failed
          ? nav && nav.offset !== 0
            ? "Could not read that month from Planning Center"
            : "Could not read the calendar from Planning Center"
          : "Loading the calendar…"}
      </Notice>
    );
    if (!nav) return body;
    return (
      <div className="flex h-full min-h-0 flex-col kiosk-surface">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <CalendarDaysIcon className="size-4 text-fg-subtle" aria-hidden="true" />
          {/* No month name: the server names the month, in the app time zone,
              and it has not answered yet. Naming it here would be the browser's
              zone answering a question it does not own. */}
          <span className="text-footnote font-title text-fg-subtle">—</span>
          <span className="flex items-center gap-0.5">
            <NavButton label="Previous month" onClick={nav.onPrev} disabled={!nav.canPrev}>
              <ChevronLeftIcon className="size-4" aria-hidden="true" />
            </NavButton>
            <NavButton label="Next month" onClick={nav.onNext} disabled={!nav.canNext}>
              <ChevronRightIcon className="size-4" aria-hidden="true" />
            </NavButton>
            {nav.offset !== 0 && (
              <button
                type="button"
                onClick={nav.onToday}
                className="ml-1 rounded px-1.5 py-0.5 text-caption2 text-fg-subtle hover:text-fg hover:bg-fill-active focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                Today
              </button>
            )}
          </span>
        </div>
        <div className="min-h-0 flex-1">{body}</div>
      </div>
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
        {/* The label is the SERVER's, rendered in the app time zone. A month name
            computed here would be the browser's idea of the month. */}
        <span className="text-footnote font-title text-fg">{grid.monthLabel}</span>
        {nav && (
          <span className="flex items-center gap-0.5">
            <NavButton label="Previous month" onClick={nav.onPrev} disabled={!nav.canPrev}>
              <ChevronLeftIcon className="size-4" aria-hidden="true" />
            </NavButton>
            <NavButton label="Next month" onClick={nav.onNext} disabled={!nav.canNext}>
              <ChevronRightIcon className="size-4" aria-hidden="true" />
            </NavButton>
            {/* Only once paged away. On the current month it would do nothing,
                and a live control that does nothing reads as broken. */}
            {nav.offset !== 0 && (
              <button
                type="button"
                onClick={nav.onToday}
                className="ml-1 rounded px-1.5 py-0.5 text-caption2 text-fg-subtle hover:text-fg hover:bg-fill-active focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                Today
              </button>
            )}
          </span>
        )}
        {/* The failure wins the slot. An operator looking at a month that has
            stopped updating needs to be told that before anything else, and a
            "nothing this month" on a stale grid is the lie this says instead. */}
        {failed ? (
          <span className="ml-auto text-caption2 text-warn-11">
            {nav && nav.offset !== 0
              ? "Could not read that month from Planning Center"
              : "Could not reach Planning Center — showing the last month read"}
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
 * How long a console sits on a month it was paged to before dropping back.
 *
 * Ten minutes: long enough that reading last December is not interrupted, short
 * enough that a console paged to March on Thursday is showing this month again
 * by Sunday. A wall display never pages at all, so this only ever affects a
 * surface someone was standing at.
 */
const IDLE_RESET_MS = 10 * 60_000;

/**
 * "YYYY-MM", `offset` months from now, in the grid's zone.
 *
 * The zone comes from the live grid the server sent. Before that arrives there
 * is nothing to page from — the chevrons have no month to be relative to — so
 * the browser's own zone is the only available answer and is used as one. The
 * server re-derives the offset in the APP zone from whatever key it receives, so
 * a disagreement here can only ever be about which month the client ASKED for,
 * never about which month it is served.
 */
function monthKeyFor(offset: number, zone: string | undefined): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(zone ? { timeZone: zone } : {}),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Date.UTC normalises month -1 or 12 into the neighbouring year, so no
  // wrap-around case is written by hand.
  const d = new Date(Date.UTC(get("year"), get("month") - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The kiosk route and the layout embed both come through here.
 *
 * PUSHED, not polled. An earlier version refetched on a three-minute interval in
 * every client, which on a nine-tile producer multiview is nine clients asking
 * the server every three minutes for data that changes twice a week. The server
 * keeps the timer — one read for the whole building — and sends a frame only
 * when the grid is not what it was. See main/services/calendar-broadcaster.ts.
 *
 * Hydrate-on-mount as well as subscribe, following use-reaper-state. The channel
 * is in HYDRATED_CHANNELS so a late subscriber gets the connect-time snapshot
 * replayed, but that snapshot cannot contain a calendar view created since the
 * page loaded — and this hook's whole job is one specific view id.
 */
export function CalendarView({
  viewId,
  pcoConfigured,
  interactive = false,
  nowMs,
}: {
  viewId: string | null;
  /** From the stage state the caller already holds. Required for the reason
   *  CalendarMonth's copy is. */
  pcoConfigured: boolean;
  /**
   * Whether this surface is operable — capabilityLive(ctx, "control"). False on
   * a wall display, which therefore gets no chevrons and always shows the
   * current month.
   */
  interactive?: boolean;
  nowMs?: number;
}) {
  /** The month pushed on the channel. Always the CURRENT one. */
  const [liveGrid, setLiveGrid] = useState<CalendarGrid | null>(null);
  /**
   * A month the operator paged to, TAGGED with the month it is.
   *
   * The tag is what makes the value derivable rather than something an effect
   * has to clear: while a new month is in flight the tag does not match, so it
   * simply is not rendered. Storing a bare grid meant clearing it synchronously
   * inside an effect, which cascades a render — and until it was cleared, the
   * PREVIOUS month's grid was on screen under the new month's heading.
   */
  const [paged, setPaged] = useState<{ key: string; grid: CalendarGrid } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  /**
   * Months from the current one. REACT STATE, per client, and deliberately not
   * on the View.
   *
   * A View can be routed to several screens at once, so an offset stored in its
   * config would page every wall display in the building to December because one
   * operator looked at December on their console. That is the same shape as a
   * per-device setting kept globally.
   *
   * Starting at 0 also means a remount resets it, which is half of "a console
   * left on March must not still be on March on Sunday".
   */
  const [offset, setOffset] = useState(0);

  // Wall displays cannot page at all, so nothing can leave one on the wrong
  // month even if a stray offset ever got set.
  const shown = interactive ? offset : 0;

  useEffect(() => {
    let cancelled = false;
    invoke<CalendarGrid>("calendar:getGrid", { viewId }).then(
      (g) => {
        if (cancelled) return;
        setFailed(false);
        if (g) setLiveGrid(g);
      },
      () => {
        // REPORTED, not swallowed: a calendar that quietly empties itself is the
        // absence nobody reports. CalendarMonth keeps the last good month on
        // screen under the notice rather than blanking it.
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [viewId]);

  // The push. The payload is a map keyed by view id, because two calendar views
  // can filter to two different departments — a frame that did not name the view
  // could not say which grid it carried.
  useEffect(() => {
    if (!viewId) return;
    return onNotification("calendar:grid", (p) => {
      const next = (p as Record<string, CalendarGrid> | null)?.[viewId];
      if (!next) return;
      setLiveGrid(next);
      // A frame arriving IS the server reaching Planning Center, so it clears a
      // stale marker that an earlier failure put up.
      setFailed(false);
    });
  }, [viewId]);

  /**
   * A month the operator paged to — fetched once and left alone.
   *
   * ONLY for a non-zero offset. Serving the current month from here too would
   * look harmless and would break the live path: the grid on screen would be a
   * frozen copy taken at page time, and every subsequent push would land in
   * liveGrid where nothing was reading it. Paging away and back would leave a
   * display quietly showing a stale month.
   *
   * The generation counter is not decoration. Clicking a chevron twice quickly
   * starts two requests, and the FIRST can answer second — without this, holding
   * a chevron down lands the display on whichever month the network happened to
   * finish last.
   */
  // The month travels as a DATE, not an offset: a page left open across midnight
  // on the 31st must not have its "+1" quietly mean a different month than it did
  // when the operator clicked. null on the current month, which is never fetched.
  const wantedKey = useMemo(
    () => (shown === 0 ? null : monthKeyFor(shown, liveGrid?.zone)),
    [shown, liveGrid?.zone],
  );

  // Derived, not cleared: a grid for a month we are no longer showing is simply
  // not the one rendered.
  const pagedGrid = paged && paged.key === wantedKey ? paged.grid : null;

  useEffect(() => {
    if (wantedKey === null) return;
    let cancelled = false;
    // Debounced, so a held-down chevron walks the offset without firing a
    // request per step.
    const t = setTimeout(() => {
      invoke<CalendarGrid>("calendar:getGrid", { viewId, month: wantedKey }).then(
        (g) => {
          if (cancelled) return;
          // Tagged with the month it answers, so a slow reply for a month the
          // operator has already paged past cannot land on the screen.
          setPaged(g ? { key: wantedKey, grid: g } : null);
          setFailed(!g);
        },
        () => {
          if (cancelled) return;
          // Blanked ON PURPOSE, unlike the live month. The operator asked a
          // specific question; leaving the previous month on screen under a
          // notice would look like the answer to it.
          setPaged(null);
          setFailed(true);
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [wantedKey, viewId]);

  /**
   * Drop back to the current month after a spell of not touching it.
   *
   * A console paged to March and walked away from must not still be on March on
   * Sunday morning. There is no reusable idle helper in this app — the only
   * other idle timer is the kiosk cursor-hide in main/index.tsx, which is an
   * inline setTimeout reset by input events — so this takes the same shape at a
   * length suited to a room rather than a pointer.
   */
  useEffect(() => {
    if (offset === 0) return;
    const t = setTimeout(() => setOffset(0), IDLE_RESET_MS);
    return () => clearTimeout(t);
  }, [offset]);

  // A minute is enough: the highlight moves between events, and the day rolls
  // over. A one-second tick would re-render the whole grid sixty times as often
  // for a change nobody can see.
  useEffect(() => {
    if (nowMs !== undefined) return;
    const t = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [nowMs]);

  return (
    <CalendarMonth
      // The live month on 0, the one-shot otherwise. The current month is never
      // served from pagedGrid — see the effect above for why that matters.
      grid={shown === 0 ? liveGrid : pagedGrid}
      nowMs={nowMs ?? tick}
      pcoConfigured={pcoConfigured}
      failed={failed}
      nav={
        interactive
          ? {
              offset: shown,
              canPrev: shown > -MAX_MONTH_OFFSET,
              canNext: shown < MAX_MONTH_OFFSET,
              onPrev: () => setOffset((o) => Math.max(-MAX_MONTH_OFFSET, o - 1)),
              onNext: () => setOffset((o) => Math.min(MAX_MONTH_OFFSET, o + 1)),
              onToday: () => setOffset(0),
            }
          : null
      }
    />
  );
}
