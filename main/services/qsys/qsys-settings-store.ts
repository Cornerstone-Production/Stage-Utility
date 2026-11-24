// qsys-settings-store.ts — what the Q-SYS integration keeps that the
// Integrations panel does not: the meter poll rates.
//
// Host, port, user and the enabled flag are the integration's own config (the
// manager holds them, like every other integration); the password is in
// secretsStore under integration "qsys", key "password". QsysService is handed
// all of it as one QsysSettings.

import { DataStore } from "../data-store.js";
import { asObject, checked, optional } from "../restore-check.js";

export interface QsysSettings {
  host: string;
  port: number;
  user: string;
  enabled: boolean;
  volunteerMeterHz: number;
  staffMeterHz: number;
}

export type QsysMeterRates = Pick<QsysSettings, "volunteerMeterHz" | "staffMeterHz">;

export const QSYS_DEFAULTS: QsysSettings = {
  host: "",
  port: 1710,
  user: "",
  enabled: false,
  volunteerMeterHz: 10,
  staffMeterHz: 20,
};

const MIN_HZ = 1;
const MAX_HZ = 30;

function rate(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(MAX_HZ, Math.max(MIN_HZ, Math.round(v))) : fallback;
}

const restoreCheck = checked((raw) => {
  const o = asObject(raw, "the Q-SYS settings");
  optional(o.volunteerMeterHz, "number", "volunteerMeterHz");
  optional(o.staffMeterHz, "number", "staffMeterHz");
  return {
    volunteerMeterHz: rate(o.volunteerMeterHz, QSYS_DEFAULTS.volunteerMeterHz),
    staffMeterHz: rate(o.staffMeterHz, QSYS_DEFAULTS.staffMeterHz),
  };
});

const store = new DataStore<QsysMeterRates>(
  "qsys-settings.json",
  { volunteerMeterHz: QSYS_DEFAULTS.volunteerMeterHz, staffMeterHz: QSYS_DEFAULTS.staffMeterHz },
  "config",
  { restoreCheck },
);

export const qsysSettingsStore = {
  async loadRates(): Promise<QsysMeterRates> {
    const s = await store.load();
    return {
      volunteerMeterHz: rate(s.volunteerMeterHz, QSYS_DEFAULTS.volunteerMeterHz),
      staffMeterHz: rate(s.staffMeterHz, QSYS_DEFAULTS.staffMeterHz),
    };
  },
  async saveRates(next: QsysMeterRates): Promise<QsysMeterRates> {
    const value = { volunteerMeterHz: rate(next.volunteerMeterHz, QSYS_DEFAULTS.volunteerMeterHz), staffMeterHz: rate(next.staffMeterHz, QSYS_DEFAULTS.staffMeterHz) };
    await store.save(value);
    return value;
  },
};
