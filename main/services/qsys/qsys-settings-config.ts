// The pure half of the Q-SYS settings: the meter-rate bounds and how a config
// save is split between the integration's own config and the rates store.
// No store, no logging, so it can be tested without either.

import type { QsysMeterRates } from "./qsys-settings-store.js";

/** Meter polls per second the integration accepts, whole numbers. */
export const QSYS_MIN_HZ = 1;
export const QSYS_MAX_HZ = 30;

/** A rate as a whole number inside the bounds, or `fallback` when it is not a finite number. */
export function clampRate(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(QSYS_MAX_HZ, Math.max(QSYS_MIN_HZ, Math.round(v)))
    : fallback;
}

const RATE_KEYS = ["volunteerMeterHz", "staffMeterHz"] as const;

/**
 * Split a Q-SYS config save. The two rates belong to the rates store, not to the
 * integration's config; they come back clamped, and only the ones the body
 * actually carried as numbers. A rate that is not a number is dropped (and named
 * in `ignored`), so a malformed body cannot overwrite a stored 15 with the default.
 */
export function splitQsysConfig(config: Record<string, unknown>): {
  rest: Record<string, unknown>;
  rates: Partial<QsysMeterRates>;
  /** Rate keys the body carried that were not numbers; the caller logs them. */
  ignored: string[];
} {
  const rest: Record<string, unknown> = Object.create(null);
  const rates: Partial<QsysMeterRates> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if ((RATE_KEYS as readonly string[]).includes(key)) {
      const key2 = key as (typeof RATE_KEYS)[number];
      if (typeof value === "number" && Number.isFinite(value)) rates[key2] = clampRate(value, value);
      else ignored.push(key2);
    } else {
      rest[key] = value;
    }
  }
  return { rest, rates, ignored };
}

/** A Q-SYS config as the card sees it: the saved connection fields with the
 *  stored meter rates laid over them. The one place init() and setConfig() both
 *  build that from. */
export function withQsysRates(config: Record<string, unknown>, rates: QsysMeterRates): Record<string, unknown> {
  return { ...config, ...rates };
}
