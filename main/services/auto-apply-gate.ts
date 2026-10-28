// auto-apply-gate.ts — whether the server installs an update on its own right now.
//
// The server's own updater runs at the hour (and day) the operator chose, and
// never during a service. "During a service" is what Planning Center last
// reported live. When that reading is not current (Planning Center is not
// answering, or has not answered since boot), a service may have gone live since,
// so the gate falls back on the service windows computed from the cached plans:
// inside one, it waits; outside one, the scheduled hour is as safe as it was.
// Waiting for Planning Center itself would hold every update for as long as an
// outage, or bad credentials, lasted.
//
// Pure: stage-controller.ts gathers the inputs.

import type { AutoUpdateSettings } from "../types/stage.js";
import type { ZonedParts } from "./app-timezone.js";

export interface AutoApplyInput {
  cfg: AutoUpdateSettings;
  behind: number;
  updating: boolean;
  /** Planning Center's last reading says a service is live. */
  serviceLive: boolean;
  /** That reading is current: true without Planning Center or a followed plan. */
  liveKnown: boolean;
  /** When the cached service window open now closes, or null outside one. */
  windowUntil: number | null;
  /** `now` in the app's time zone. */
  now: Pick<ZonedParts, "weekday" | "hour">;
}

/** "window": waiting only because the live state is unknown and a cached window is
 *  open, the one decline worth a log line; the rest are the schedule doing its job. */
export type AutoApplyDecision = { apply: true } | { apply: false; why: "off" | "schedule" | "live" | "window" };

export function autoApplyDecision(input: AutoApplyInput): AutoApplyDecision {
  const { cfg, now } = input;
  if (cfg.mode === "manual" || input.behind <= 0 || input.updating) return { apply: false, why: "off" };
  if (cfg.dayOfWeek != null && now.weekday !== cfg.dayOfWeek) return { apply: false, why: "schedule" };
  if (now.hour !== cfg.hour) return { apply: false, why: "schedule" };
  if (input.serviceLive) return { apply: false, why: "live" };
  if (!input.liveKnown && input.windowUntil !== null) return { apply: false, why: "window" };
  return { apply: true };
}
