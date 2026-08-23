// schedule-calendar.tsx — the week, and dragging a slot onto it.
//
// A schedule list answers "what rules exist". It does not answer the question an
// operator actually has, which is "what is on the foyer screens on Sunday
// morning, and does anything clash" — that one needs a picture.
//
// Dragging works the way a calendar does, because that is the whole point of
// asking for one: press on empty space, drag, let go, and the slot exists. The
// arithmetic lives in week-layout, which is pure and tested; this file owns the
// pointer and the paint.
//
// WHEN a window is open comes from intervalsOnDay in signage-window — the same
// function the resolver uses. A calendar that worked it out again would
// eventually draw a picture of a schedule nobody is running.

import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { PcoWindow, SignagePlaylist, SignageSchedule } from "@main/types/signage";

import { intervalsOnDay, localDayStart } from "@main/services/signage-window";
import { zonedParts, type TimeZone } from "@main/services/app-timezone";
import { Button } from "../../components/ui/button";
import { useNow } from "./use-now";
import { layOutDay, dragToTimes, type WeekBlock } from "./week-layout";
import { weekOf } from "./week-layout";

const DAY_MS = 86_400_000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Every third hour gets a label; all 24 is a wall of numbers. */
const HOUR_MARKS = [0, 3, 6, 9, 12, 15, 18, 21];

/** A colour per playlist, so a week reads as a pattern rather than a list.
 *  Hashed from the id, so a playlist keeps its colour between sessions.
 *
 *  Blue through green through amber to red, and NO purple or magenta — this app
 *  has none anywhere, and a hash that occasionally produced one would put a
 *  violet slab across the whole week. */
const HUES = [201, 152, 43, 12, 178, 96, 225, 28];
function hueOf(playlistId: string): number {
  let n = 0;
  for (let i = 0; i < playlistId.length; i++) n = (n * 31 + playlistId.charCodeAt(i)) >>> 0;
  return HUES[n % HUES.length];
}

export function ScheduleCalendar({
  schedules,
  playlists,
  pcoWindows,
  tz,
  onOpen,
  onCreate,
}: {
  schedules: SignageSchedule[];
  playlists: SignagePlaylist[];
  pcoWindows: PcoWindow[];
  tz: TimeZone;
  /** Clicking a block opens it in the editor. */
  onOpen: (schedule: SignageSchedule) => void;
  /** A finished drag: a new weekly slot on this weekday, at these times. */
  onCreate: (weekday: number, start: string, end: string) => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  /** The drag in progress, in day-fractions. `onBlock` is the schedule the press
   *  landed on, if any — a press that does not turn into a drag opens it. */
  const [drag, setDrag] = useState<{
    day: number;
    from: number;
    to: number;
    onBlock: SignageSchedule | null;
  } | null>(null);

  const playlistName = useMemo(
    () => new Map(playlists.map((p) => [p.id, p.name])),
    [playlists],
  );

  // A minute is plenty: this decides which week is shown and which column is
  // today. Reading the clock during render is impure, and two renders of the
  // same props would disagree about the date at midnight.
  const now = useNow(60_000);

  const days = useMemo(() => {
    const anchor = now + weekOffset * 7 * DAY_MS;
    return weekOf(
      anchor,
      (ms) => localDayStart(ms, tz),
      (ms) => zonedParts(ms, tz).weekday,
    );
  }, [now, weekOffset, tz]);

  const blocks = useMemo(() => {
    const ctx = { pcoWindows, liveServiceTypeId: null };
    return days.flatMap((dayStart, i) => {
      const dayEnd = localDayStart(dayStart + DAY_MS + 3 * 3600_000, tz);
      const intervals = schedules.flatMap((schedule) =>
        intervalsOnDay(schedule.window, dayStart, tz, ctx).map((iv: { from: number; to: number }) => ({
          schedule,
          from: iv.from,
          to: iv.to,
        })),
      );
      return layOutDay({ dayStart, dayEnd, intervals }, i);
    });
  }, [days, schedules, pcoWindows, tz]);

  /** Where in the grid a pointer is: which day, and how far down it.
   *
   *  Both from the GRID's box, not from a column element. Blocks are painted
   *  over the whole grid as siblings of the columns, so a press on a block never
   *  reaches a column's handler — which silently made drag-to-create impossible
   *  anywhere a schedule already ran, including every column of a week with one
   *  always-on schedule in it. */
  const pointAt = useCallback((clientX: number, clientY: number) => {
    const box = gridRef.current?.getBoundingClientRect();
    if (!box || box.height === 0 || box.width === 0) return { day: 0, fraction: 0 };
    const day = Math.min(6, Math.max(0, Math.floor(((clientX - box.left) / box.width) * 7)));
    return { day, fraction: (clientY - box.top) / box.height };
  }, []);

  const finishDrag = useCallback(() => {
    if (!drag) return;
    setDrag(null);
    // A press that never moved is a CLICK, not a drag. On a block it opens that
    // block; on empty space it makes the smallest slot, which is what clicking
    // an empty calendar does everywhere else.
    if (Math.abs(drag.to - drag.from) < CLICK_SLOP) {
      if (drag.onBlock) onOpen(drag.onBlock);
      else {
        const { start, end } = dragToTimes(drag.from, drag.from);
        onCreate(drag.day, start, end);
      }
      return;
    }
    const { start, end } = dragToTimes(drag.from, drag.to);
    onCreate(drag.day, start, end);
  }, [drag, onCreate, onOpen]);

  const todayIndex = days.findIndex((d) => d === localDayStart(now, tz));
  /** How far down the column "right now" is, when this week contains today. */
  const nowFraction =
    todayIndex === -1
      ? null
      : (now - days[todayIndex]) /
        Math.max(1, localDayStart(days[todayIndex] + DAY_MS + 3 * 3600_000, tz) - days[todayIndex]);

  // Open on the current hour rather than at midnight — the top of a 24-hour
  // column is the part of the day nothing is ever scheduled in.
  const scrolled = useRef(false);
  const scrollBody = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || scrolled.current || nowFraction === null) return;
      scrolled.current = true;
      el.scrollTop = Math.max(0, nowFraction * el.scrollHeight - el.clientHeight / 3);
    },
    [nowFraction],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="small" iconOnly tooltip="Previous week" onClick={() => setWeekOffset((w) => w - 1)}>
          <ChevronLeftIcon className="size-3.5" />
        </Button>
        <Button size="small" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>
          This week
        </Button>
        <Button size="small" iconOnly tooltip="Next week" onClick={() => setWeekOffset((w) => w + 1)}>
          <ChevronRightIcon className="size-3.5" />
        </Button>
        <span className="text-caption1 text-fg-subtle">
          {rangeLabel(days, tz)}
        </span>
        <span className="ml-auto text-caption2 text-fg-subtle">
          Drag on a day to add a slot
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
        {/* Day headings, outside the scrolling body so they stay put. */}
        <div className="flex border-b border-line">
          <div className="w-12 shrink-0" />
          {days.map((dayStart, i) => {
            const p = zonedParts(dayStart, tz);
            return (
              <div key={dayStart} className="flex-1 px-1 py-1.5 text-center">
                <div className="text-caption2 uppercase tracking-wide text-fg-subtle">{DAY_NAMES[i]}</div>
                <div
                  className={
                    i === todayIndex
                      ? "mx-auto mt-0.5 grid size-6 place-items-center rounded-full bg-accent text-caption1 font-medium text-white"
                      : "mt-0.5 text-caption1 text-fg"
                  }
                >
                  {p.day}
                </div>
              </div>
            );
          })}
        </div>

        <div ref={scrollBody} className="relative flex max-h-[58vh] overflow-y-auto">
          {/* The hour gutter. */}
          <div className="relative w-12 shrink-0 border-r border-line" style={{ height: HOUR_HEIGHT * 24 }}>
            {HOUR_MARKS.map((h) => (
              <span
                key={h}
                className="absolute right-1 text-caption2 tabular-nums text-fg-faint"
                // Sat just BELOW its hour line rather than centred on it, so the
                // midnight label is not half-clipped by the top of the column.
                style={{ top: `calc(${(h / 24) * 100}% + 1px)` }}
              >
                {`${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`}
              </span>
            ))}
          </div>

          <div
            ref={gridRef}
            className="relative flex flex-1"
            style={{ height: HOUR_HEIGHT * 24 }}
            onPointerDown={(e) => {
              // Left button only: a right-click is a context menu, not a slot.
              if (e.button !== 0) return;
              const hit = (e.target as HTMLElement).closest("[data-block]");
              const id = hit?.getAttribute("data-block") ?? "";
              e.currentTarget.setPointerCapture(e.pointerId);
              const { day, fraction } = pointAt(e.clientX, e.clientY);
              setDrag({
                day,
                from: fraction,
                to: fraction,
                onBlock: schedules.find((s) => s.id === id) ?? null,
              });
            }}
            onPointerMove={(e) => {
              // The DAY is fixed at press. Dragging sideways in a calendar
              // extends the time, it does not move the slot to another day.
              if (drag) setDrag({ ...drag, to: pointAt(e.clientX, e.clientY).fraction });
            }}
            onPointerUp={finishDrag}
            // A pointer that leaves the grid mid-drag still finishes it, rather
            // than leaving a ghost selection stuck to the cursor.
            onPointerLeave={() => drag && finishDrag()}
          >
            {/* Hour lines, drawn once across the whole grid. */}
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                aria-hidden
                className="pointer-events-none absolute inset-x-0 border-t border-line/50"
                style={{ top: (h / 24) * 100 + "%" }}
              />
            ))}

            {days.map((dayStart, i) => (
              <div
                key={dayStart}
                data-day={i}
                aria-hidden
                className="flex-1 border-r border-line/50 last:border-r-0"
              />
            ))}

            {drag ? (
              <div
                aria-hidden
                className="pointer-events-none absolute z-20 rounded border-2 border-accent bg-accent/25"
                style={{
                  left: `calc(${(drag.day / 7) * 100}% + 2px)`,
                  width: `calc(${(1 / 7) * 100}% - 4px)`,
                  top: Math.min(drag.from, drag.to) * 100 + "%",
                  height: Math.abs(drag.to - drag.from) * 100 + "%",
                }}
              />
            ) : null}

            {nowFraction !== null ? (
              <div
                aria-hidden
                className="pointer-events-none absolute z-10 h-px bg-live-9"
                style={{
                  top: nowFraction * 100 + "%",
                  left: (todayIndex / 7) * 100 + "%",
                  width: (1 / 7) * 100 + "%",
                }}
              >
                <span className="absolute -left-0.5 -top-1 size-2 rounded-full bg-live-9" />
              </div>
            ) : null}

            {blocks.map((b, i) => (
              <ScheduleBlock
                key={`${b.schedule.id}-${b.day}-${i}`}
                block={b}
                playlistName={playlistName.get(b.schedule.playlistId) ?? "no playlist"}
                tz={tz}
                onOpen={() => onOpen(b.schedule)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Tall enough that a 15-minute slot is still a clickable target. */
const HOUR_HEIGHT = 34;

/** Below this much movement a press is a click, not a drag. Roughly 5px of a
 *  24-hour column — a hand does not hold perfectly still on a trackpad. */
const CLICK_SLOP = 0.006;

function ScheduleBlock({
  block,
  playlistName,
  tz,
  onOpen,
}: {
  block: WeekBlock;
  playlistName: string;
  tz: TimeZone;
  onOpen: () => void;
}) {
  const hue = hueOf(block.schedule.playlistId);
  const dim = !block.schedule.enabled || block.beatenBy !== null;
  const height = block.bottom - block.top;
  /** Below about an hour tall there is only room for the name. */
  const roomFor = (lines: number) => height * 24 * HOUR_HEIGHT >= lines * 13 + 6;
  const times = `${shortTime(block.from, tz)} – ${shortTime(block.to, tz)}`;

  return (
    <button
      data-block={block.schedule.id}
      type="button"
      // Keyboard only. A mouse click arrives as a zero-length drag on the
      // column, which opens it there — handling it here as well would open it
      // twice, and a real drag that ENDED over a block would also fire this.
      onClick={(e) => e.detail === 0 && onOpen()}
      title={
        block.beatenBy
          ? `${block.schedule.name}, ${times} — beaten here by ${block.beatenBy}`
          : `${block.schedule.name}, ${times} — ${playlistName}`
      }
      // flex-col/items-start rather than relying on the default: a <button>
      // CENTRES its content vertically, so a tall block put its label in the
      // middle of the slab rather than at the time the slot starts.
      className="absolute flex flex-col items-start overflow-hidden rounded-md px-1.5 py-0.5 text-left transition-opacity hover:opacity-90"
      style={{
        // Positioned against the whole grid, then narrowed to its day column and
        // its share of any overlap — so two blocks at the same time sit beside
        // each other rather than on top of one another.
        left: `calc(${((block.day + block.column / block.columns) / 7) * 100}% + 2px)`,
        width: `calc(${(1 / 7 / block.columns) * 100}% - 4px)`,
        top: block.top * 100 + "%",
        height: `calc(${(block.bottom - block.top) * 100}% - 2px)`,
        background: `hsl(${hue} 55% 42% / ${dim ? 0.28 : 0.92})`,
        borderLeft: block.continued ? "none" : `3px solid hsl(${hue} 60% 62%)`,
        // A beaten block is struck through with a hatch rather than merely
        // faded: faded reads as "disabled", and this one is enabled and simply
        // losing.
        backgroundImage: block.beatenBy
          ? "repeating-linear-gradient(45deg, rgba(255,255,255,.18) 0 4px, transparent 4px 8px)"
          : undefined,
        color: dim ? "var(--color-fg-muted)" : "white",
      }}
    >
      <span className="block truncate text-caption2 font-medium leading-tight">
        {block.continued ? "↑ " : ""}
        {block.schedule.name}
      </span>
      {roomFor(2) ? (
        <span className="block truncate text-caption2 leading-tight opacity-80">{times}</span>
      ) : null}
      {roomFor(3) ? (
        <span className="block truncate text-caption2 leading-tight opacity-80">{playlistName}</span>
      ) : null}
      {block.beatenBy && roomFor(4) ? (
        <span className="block truncate text-caption2 leading-tight opacity-90">
          beaten by {block.beatenBy}
        </span>
      ) : null}
    </button>
  );
}

/** "5am" / "1:30pm" — the way a calendar writes a time, with the minutes only
 *  when there are any. */
function shortTime(ms: number, tz: TimeZone): string {
  const p = zonedParts(ms, tz);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const suffix = p.hour < 12 ? "am" : "pm";
  return p.minute === 0 ? `${h}${suffix}` : `${h}:${String(p.minute).padStart(2, "0")}${suffix}`;
}

function rangeLabel(days: number[], tz: TimeZone): string {
  if (days.length === 0) return "";
  const a = zonedParts(days[0], tz);
  const b = zonedParts(days[days.length - 1], tz);
  const month = (m: number) =>
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return a.month === b.month
    ? `${month(a.month)} ${a.day}–${b.day}`
    : `${month(a.month)} ${a.day} – ${month(b.month)} ${b.day}`;
}
