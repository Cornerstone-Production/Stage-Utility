// settings-rules.ts — the rules a settings.json value is held to.
//
// Each is used by the setter or route that saves the value AND by a config
// restore (settings-restore-check.ts), so the two cannot drift apart. Pure: no
// store, no I/O.

import { clamp } from "./clamp.js";
import { isSafeKey } from "./safe-key.js";

/** A `#rrggbb` colour, either case. */
export function isHex6(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** An icon-colour or icon-glyph key: an id or a tool path, never a prototype name. */
export function isIconKey(key: string): boolean {
  return /^[A-Za-z0-9/_-]{1,64}$/.test(key) && isSafeKey(key);
}

/** An icon colour as stored: lowercase `#rrggbb` (the setter lowercases first). */
export const ICON_COLOR = /^#[0-9a-f]{6}$/;

/** An icon glyph name. */
export const ICON_GLYPH = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** A caption channel colour, with or without its `#`. */
export const CAPTION_COLOR = /^#?[0-9a-f]{3,8}$/i;

/** A caption colour as setCaptionChannelColor stores it: trimmed, with its `#`. */
export function normalizeCaptionColor(color: string): string {
  const c = color.trim();
  return c.startsWith("#") ? c : `#${c}`;
}

/** The longest keyword that starts the baptism testimonies by itself. */
export const MAX_TESTIMONY_KEYWORD = 80;

/** The shortest wireless metering interval: 0 would be a busy loop. */
const MIN_METER_RATE_MS = 100;

/**
 * A user-entered base URL: trimmed, `http://` when it names no scheme, no
 * trailing slash; null for blank. Null too for anything that is then not an
 * http or https URL, which the caller refuses.
 */
export function normalizeBaseUrl(url: string | null): string | null {
  if (!url) return null;
  let s = url.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

/** Whether a normalized base URL parses as http or https with a host. */
export function isHttpBaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    // Not a URL at all: that is the answer, not a swallowed failure.
    return false;
  }
}

export function clampAutoUpdateHour(hour: number): number {
  return clamp(Math.round(hour), 0, 23);
}

export function clampAutoUpdateDay(day: number | null): number | null {
  return day == null ? null : clamp(Math.round(day), 0, 6);
}

/** Reconnect-schedule minutes, each into its own range. */
export const RECONNECT_RANGES = { leadMin: [0, 1440], tailMin: [0, 1440], dormantMin: [1, 1440] } as const;

/** Attendance capture windows, in minutes. */
export const TAPER_RANGES = { preMin: [0, 240], postMin: [0, 240] } as const;

/** Every numeric field `ranges` names, rounded and clamped; the rest as given. */
export function clampFields<T extends object>(value: T, ranges: Record<string, readonly [number, number]>): T {
  const out = { ...value } as Record<string, unknown>;
  for (const [field, [lo, hi]] of Object.entries(ranges)) {
    if (typeof out[field] === "number") out[field] = clamp(Math.round(out[field] as number), lo, hi);
  }
  return out as T;
}

export function clampOscFeedbackPort(port: number): number {
  return clamp(Math.floor(port), 1, 65535);
}

export function clampMeterRate(ms: number): number {
  return Math.max(MIN_METER_RATE_MS, Math.floor(ms));
}

/** The automatic-backup schedule as setSchedule stores it. */
export function clampSchedule<S extends { intervalDays?: number; keep?: number; destination?: string }>(s: S): S {
  const out = { ...s };
  if (out.intervalDays != null) out.intervalDays = clamp(Math.round(out.intervalDays), 1, 365);
  if (out.keep != null) out.keep = clamp(Math.round(out.keep), 1, 100);
  if (out.destination != null) out.destination = out.destination.trim();
  return out;
}
