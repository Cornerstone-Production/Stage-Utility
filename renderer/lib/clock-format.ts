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
  try {
    return d.toLocaleTimeString(undefined, clockOptions(o));
  } catch {
    // An invalid timeZone from a saved layout should not blank the whole panel.
    return d.toLocaleTimeString(undefined, clockOptions({ ...o, timeZone: null }));
  }
}
