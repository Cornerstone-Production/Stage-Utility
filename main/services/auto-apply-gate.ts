// auto-apply-gate.ts — whether the server installs an update on its own right now.
//
// The server's own updater runs at the hour (and day) the operator chose, and
// never near a service. Two things hold it:
//
//   - a service under way: service-activity.ts's answer, the one the update lock
//     reads (Planning Center in an item, or a recorder still open);
//   - the service window: the time around a rehearsal or service, worked out
//     from the cached plans (service-window.ts), the same window the Mac helpers'
//     updates and the page deploy wait out. Whether Planning Center's live
//     reading is current does not matter: an unattended restart minutes before
//     a service, or between two, is what this is for, and Planning Center reports
//     nothing live then.
//
// A scheduled hour declined for a window, or for a service under way, leaves the
// update OWED: it applies at the first check with neither, rather than at the next
// scheduled hour. A schedule that always falls in a window (Sunday 03:00 with a
// Thursday rehearsal), or a slot a service ran over, would otherwise be lost for
// the week, or never apply at all, and say nothing.
//
// Outside a window, with nothing under way, the scheduled hour applies, even while
// Planning Center is not answering: waiting for it would hold every update for as
// long as an outage, or bad credentials, lasted.
//
// The operator's Update now is not this gate: it holds only while a service is
// under way, and can be overridden.
//
// Pure: stage-controller.ts gathers the inputs. The settings it reads come
// through migrateAutoUpdate, here so its tests call the real one.

import type { AutoUpdateSettings } from "../types/stage.js";
import { isUpdateMode } from "../types/state.js";
import { zonedParts, type TimeZone, type ZonedParts } from "./app-timezone.js";

export interface AutoApplyInput {
  cfg: AutoUpdateSettings;
  behind: number;
  updating: boolean;
  /** A service is under way (service-activity.ts): a Planning Center item, or a recorder still open. */
  serviceLive: boolean;
  /** When the cached service window open now closes, or null outside one. */
  windowUntil: number | null;
  /** An earlier scheduled hour was declined for a window or a service under way, and nothing has applied since. */
  owed: boolean;
  /** `now` in the app's time zone. */
  now: Pick<ZonedParts, "weekday" | "hour">;
}

/** "window": the scheduled hour, or an owed update, fell inside a service window, the
 *  one decline worth a log line; the rest are the schedule doing its job. `late`: an
 *  owed update applying outside its scheduled hour. */
export type AutoApplyDecision = { apply: true; late?: true } | { apply: false; why: "off" | "schedule" | "live" | "window" };

export function autoApplyDecision(input: AutoApplyInput): AutoApplyDecision {
  const { cfg, now } = input;
  if (cfg.mode === "manual" || input.behind <= 0 || input.updating) return { apply: false, why: "off" };
  const scheduled = (cfg.dayOfWeek == null || now.weekday === cfg.dayOfWeek) && now.hour === cfg.hour;
  if (!scheduled && !input.owed) return { apply: false, why: "schedule" };
  if (input.serviceLive) return { apply: false, why: "live" };
  if (input.windowUntil !== null) return { apply: false, why: "window" };
  return scheduled ? { apply: true } : { apply: true, late: true };
}

/**
 * The scheduled hours from `fromMs` up to `toMs`: each instant that is the top of
 * `cfg.hour`, on `cfg.dayOfWeek` (or any day), in `tz`. Stepped by fifteen minutes,
 * so a zone a half or three quarters of an hour off UTC lands on its own hour.
 */
export function scheduledTimes(cfg: AutoUpdateSettings, fromMs: number, toMs: number, tz?: TimeZone): number[] {
  const step = 15 * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil(fromMs / step) * step; t < toMs; t += step) {
    const p = zonedParts(t, tz);
    if (p.minute === 0 && p.hour === cfg.hour && (cfg.dayOfWeek == null || p.weekday === cfg.dayOfWeek)) out.push(t);
  }
  return out;
}

/**
 * Read the persisted auto-update settings, migrating the pre-mode boolean.
 * `enabled: true` meant "apply and restart in the window", which is auto-full;
 * `false`/absent meant nothing automatic at all, which is manual.
 */
export function migrateAutoUpdate(saved: unknown): AutoUpdateSettings {
  const o = (saved ?? {}) as Partial<AutoUpdateSettings> & { enabled?: boolean };
  const mode: AutoUpdateSettings["mode"] =
    isUpdateMode(o.mode)
      ? o.mode
      : o.enabled === true
        ? "auto-full"
        : "manual";
  return {
    mode,
    dayOfWeek: typeof o.dayOfWeek === "number" ? o.dayOfWeek : null,
    hour: typeof o.hour === "number" ? o.hour : 3,
  };
}
