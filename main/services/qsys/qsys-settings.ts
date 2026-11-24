// qsys-settings.ts — what QsysService is handed, and the meter-rate bounds.
//
// Every field is the integration's own config in settings.json (integrationConfigs.qsys),
// like any other integration's, except the password, which is in secretsStore under
// integration "qsys", key "password". The two meter rates are stored now for the
// Q-SYS panels, which arrive in a later release; nothing in this release reads them
// beyond handing them to the service.

import { configNumber } from "../integration-targets.js";

export interface QsysSettings {
  host: string;
  port: number;
  user: string;
  enabled: boolean;
  volunteerMeterHz: number;
  staffMeterHz: number;
}

export type QsysMeterRates = Pick<QsysSettings, "volunteerMeterHz" | "staffMeterHz">;

/** Meter polls per second the integration accepts, whole numbers. */
export const QSYS_MIN_HZ = 1;
export const QSYS_MAX_HZ = 30;

export const QSYS_DEFAULT_RATES: QsysMeterRates = { volunteerMeterHz: 10, staffMeterHz: 20 };

/** A rate as a whole number inside the bounds, or `fallback` when it is not a number.
 *  Takes what the form stored, which may be a number or the string it was typed as. */
export function clampRate(v: unknown, fallback: number): number {
  const n = configNumber(v);
  return Number.isFinite(n) ? Math.min(QSYS_MAX_HZ, Math.max(QSYS_MIN_HZ, Math.round(n))) : fallback;
}

/** The two meter rates off the integration's saved config, clamped on read: a stored
 *  value out of range, or not a number, never reaches the service as it was stored. */
export function qsysRates(cfg: Record<string, unknown>): QsysMeterRates {
  return {
    volunteerMeterHz: clampRate(cfg.volunteerMeterHz, QSYS_DEFAULT_RATES.volunteerMeterHz),
    staffMeterHz: clampRate(cfg.staffMeterHz, QSYS_DEFAULT_RATES.staffMeterHz),
  };
}
