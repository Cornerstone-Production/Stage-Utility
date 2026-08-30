// The one clock format this app displays in.
//
// Deliberately the same shape as the server's app-timezone.ts: a module-level
// value, set once from the live state, read by whoever is formatting. Every
// clock in here is a pure helper called from a dozen render paths — fmtTime,
// fmtClock, fmtSvcTime, fmtSynced — and threading a setting through all of them
// would mean a parameter on every caller of every one.
//
// Changing it re-renders everything that matters anyway: the value arrives on
// StageState, so the surfaces that show a clock are already subscribed to the
// thing that changed.
//
// This is DISPLAY only. The server's own wall-clock reasoning — which day a
// service files under, the update window, automation conditions — lives in
// app-timezone.ts and must not read this: 12h and 24h are the same instant.

export type HourCycle = "12h" | "24h";

/** What the app renders when nobody has chosen. 24h, because that is what every
 *  fixed clock in the app did before the setting existed. */
export const DEFAULT_HOUR_CYCLE: HourCycle = "24h";

let cycle: HourCycle = DEFAULT_HOUR_CYCLE;

/** Set from StageState. Called from use-stage-state, which every surface —
 *  operator app and stage display alike — goes through. */
export function setDisplayHourCycle(next: HourCycle | null | undefined): void {
  cycle = next === "12h" || next === "24h" ? next : DEFAULT_HOUR_CYCLE;
}

export function displayHourCycle(): HourCycle {
  return cycle;
}

export interface ClockOptions {
  /** Include seconds. */
  seconds?: boolean;
  /** IANA zone to render in. Omit for the viewer's own. */
  timeZone?: string | null;
  /** Override the app setting. For a surface that carries its own choice — the
   *  clock object in a custom layout has had one since before this existed. */
  hourCycle?: HourCycle | null;
}

/** Intl options for a time of day, in the app's format. */
export function clockOptions(o: ClockOptions = {}): Intl.DateTimeFormatOptions {
  const h12 = (o.hourCycle ?? cycle) === "12h";
  return {
    // 2-digit in 24h so 09:05 does not jump to 9:05 and back as the hour rolls
    // over; numeric in 12h because "08:05 PM" is not how anyone writes it.
    hour: h12 ? "numeric" : "2-digit",
    minute: "2-digit",
    ...(o.seconds ? { second: "2-digit" as const } : {}),
    hour12: h12,
    ...(o.timeZone ? { timeZone: o.timeZone } : {}),
  };
}

/**
 * A time of day split so the SECONDS can be hidden without reformatting.
 *
 * The context bar's fit ladder gives up the seconds before it gives up anything
 * else, and it has to do that without changing the rest of the reading. Formatting
 * twice — once with seconds, once without — and swapping the strings would put
 * both in the DOM, so a screen reader would read the time twice; and it is 22px
 * of duplicate node either way.
 *
 * Cutting the string by hand is wrong in 12h, where the day period follows the
 * seconds: "3:20:55 PM" is not "3:20:55" plus a suffix. So the parts come from
 * Intl itself and the seconds are lifted out with the separator that introduces
 * them, leaving `head` and `tail` to be rendered either side.
 *
 * `head + seconds + tail` is exactly `formatClock(when, { seconds: true })`.
 */
export function clockParts(
  when: number | string | Date | null | undefined,
  o: ClockOptions = {},
): { head: string; seconds: string; tail: string } {
  const blank = { head: "", seconds: "", tail: "" };
  if (when === null || when === undefined) return blank;
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return blank;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(undefined, clockOptions({ ...o, seconds: true })).formatToParts(d);
  } catch {
    // Same fallback formatClock takes: an invalid timeZone from a saved layout
    // must not blank the bar.
    parts = new Intl.DateTimeFormat(undefined, clockOptions({ ...o, seconds: true, timeZone: null }))
      .formatToParts(d);
  }

  const at = parts.findIndex((p) => p.type === "second");
  // No second part at all should not happen with `second` requested, but a locale
  // that ignored it would otherwise silently lose the whole reading here.
  if (at === -1) return { head: parts.map((p) => p.value).join(""), seconds: "", tail: "" };
  // The literal that introduces the seconds goes WITH them. Left behind it is a
  // trailing colon on a clock that has stopped showing seconds.
  const from = at > 0 && parts[at - 1]!.type === "literal" ? at - 1 : at;
  const join = (ps: Intl.DateTimeFormatPart[]) => ps.map((p) => p.value).join("");
  return {
    head: join(parts.slice(0, from)),
    seconds: join(parts.slice(from, at + 1)),
    tail: join(parts.slice(at + 1)),
  };
}

/**
 * A time of day, in the app's format.
 *
 * Returns "" for anything unparseable rather than "Invalid Date" — these render
 * into table cells and status lines where a blank reads as "not known yet",
 * which is what it means.
 */
export function formatClock(when: number | string | Date | null | undefined, o: ClockOptions = {}): string {
  if (when === null || when === undefined) return "";
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return "";
  // ONE path, shared with clockParts: both join `formatToParts`, so a split can
  // never disagree with the whole it came from.
  //
  // `toLocaleTimeString` is the obvious call and the wrong one. On Node 24 — what
  // `engines` pins and what CI runs — it emits U+0020 before the day period where
  // `formatToParts` emits U+202F, a narrow no-break space. So "8:45:30 PM" and
  // "8:45:30 PM" compared unequal, the split's own guard failed on CI, and it
  // passed on a newer Node where the two APIs happen to agree. Browsers agree
  // today too, which is exactly why this would have sat here unnoticed.
  //
  // Assembling a clock two ways gives it two answers. One way, then.
  const joinParts = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, opts).formatToParts(d).map((p) => p.value).join("");
  try {
    return joinParts(clockOptions(o));
  } catch {
    // An invalid timeZone from a saved layout should not blank the whole panel.
    return joinParts(clockOptions({ ...o, timeZone: null }));
  }
}
