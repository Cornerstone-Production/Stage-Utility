// age-label.ts — how long ago something happened: "3 min", "2 h", "14 minutes".
//
// One rule for the unit and the rounding, with the vocabulary chosen by the
// caller: a stage message's header says "now / 3 min / 2 h", the Companion
// button status says "14 minutes ago", a screen's last-seen line says "4 min
// ago". They used to be five copies that agreed on nothing but the idea.

import { plural } from "@main/services/plural";

export interface AgeOptions {
  /** Under `under` seconds there is no age to name; it reads `text` ("now",
   *  "just now") instead, and `ago` is not appended. */
  now?: { under: number; text: string };
  /** Append " ago" to a named age. */
  ago?: boolean;
  /** Name seconds ("8 s") under a minute; otherwise a minute is the floor. */
  seconds?: boolean;
  /** Minutes before the label switches to hours. 60 by default. */
  hoursFrom?: number;
  /** From 24 hours on, count days. */
  days?: boolean;
  /** "14 minutes" rather than "14 min". */
  long?: boolean;
}

/** `sec` as "8 s" / "6 min" / "2 h" / "2 d" (or the long forms). Negative ages read as zero. */
export function formatAge(sec: number, opts: AgeOptions = {}): string {
  const { now, ago = false, seconds = false, hoursFrom = 60, days = false, long = false } = opts;
  const s = Math.max(0, Math.round(sec));
  if (now && s < now.under) return now.text;
  const text = ageText(s, seconds, hoursFrom, days, long);
  return ago ? `${text} ago` : text;
}

function ageText(s: number, seconds: boolean, hoursFrom: number, days: boolean, long: boolean): string {
  if (seconds && s < 60) return long ? plural(s, "second") : `${s} s`;
  const m = Math.max(1, Math.round(s / 60));
  if (m < hoursFrom) return long ? plural(m, "minute") : `${m} min`;
  const h = Math.round(m / 60);
  if (days && h >= 24) {
    const d = Math.round(h / 24);
    return long ? plural(d, "day") : `${d} d`;
  }
  return long ? plural(h, "hour") : `${h} h`;
}

/**
 * Under 45 seconds is "now"; under 90 minutes is minutes; past that, hours. Both
 * ends are instants on the SERVER's clock, so a wall whose own clock is out still
 * reads right, and an instant stamped ahead of the clock is never negative.
 */
export function ageLabel(now: number, at: number): string {
  return formatAge((now - at) / 1000, { now: { under: 45, text: "now" }, hoursFrom: 90 });
}
