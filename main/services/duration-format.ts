// duration-format.ts — seconds as "m:ss", "h:mm:ss" and signed deltas.
//
// One place for the shapes every clock, countdown and pacing readout prints.
// It used to be written out a dozen times (pco-timer, recording status, the
// overview, baptisms, the ServiceCue columns, the YouTube pairing countdown),
// and two surfaces printed the same 4500 s item as "75:00" and "1:15:00".
// Pure, and importable from the renderer and the server alike (like
// app-timezone.ts); renderer/main/pco-timer.ts and servicecue-columns.tsx ship
// in the public ServiceCue bundle, so this file is on that bundle's list in
// scripts/servicecue-public-build.test.ts.

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface HmsOptions {
  /** How a fraction of a second goes: "round" (a countdown, a length) or
   *  "floor" (a clock that is running, which must not show a second early). */
  round?: "round" | "floor";
  /** "auto": hours only from one hour on ("59:59", "1:00:00"). "always": always
   *  h:mm:ss. "never": minutes keep counting ("75:00") for a readout that must
   *  not grow a third part. */
  hours?: "auto" | "always" | "never";
  /** Pad the hours to two digits: "01:15:00". Only with hours "always". */
  padHours?: boolean;
  /** "clamp" (default): a negative reads as zero. "minus": a leading U+2212. */
  negative?: "clamp" | "minus";
  /** From 24 h on read "2d 3h", for a pre-service wait that is days away. */
  days?: boolean;
  /** What exactly zero reads as, when it is not "0:00". */
  zero?: string;
}

export const MINUS = "−";

/** Seconds as "m:ss" or "h:mm:ss". See HmsOptions for the deliberate variants. */
export function formatHms(sec: number, opts: HmsOptions = {}): string {
  const { round = "round", hours = "auto", padHours = false, negative = "clamp", days = false, zero } = opts;
  const rounded = round === "floor" ? Math.floor(sec) : Math.round(sec);
  const neg = negative === "minus" && sec < 0;
  const s = negative === "minus" ? Math.abs(rounded) : Math.max(0, rounded);
  if (s === 0 && zero !== undefined) return zero;
  const sign = neg ? MINUS : "";
  if (days && s >= 86400) return `${sign}${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  const ss = pad2(s % 60);
  if (hours === "never") return `${sign}${Math.floor(s / 60)}:${ss}`;
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (hours === "always") return `${sign}${padHours ? pad2(h) : h}:${pad2(mm)}:${ss}`;
  return `${sign}${h > 0 ? `${h}:${pad2(mm)}` : mm}:${ss}`;
}

export interface SignedHmsOptions {
  hours?: "auto" | "never";
  days?: boolean;
  /** The text for exactly zero: "0:00" by default; "±0:00" where a sign is always drawn. */
  zero?: string;
}

/** Signed seconds as "+m:ss" / "−m:ss" (over / under plan). Rounded. */
export function formatSignedHms(sec: number, opts: SignedHmsOptions = {}): string {
  const s = Math.round(sec);
  if (s === 0) return opts.zero ?? "0:00";
  return `${s > 0 ? "+" : MINUS}${formatHms(Math.abs(s), { hours: opts.hours, days: opts.days })}`;
}
