// automation-conditions.ts — the four cross-cutting qualifiers.
//
// The test for whether something belongs here rather than as a trigger param: does
// it apply across triggers? "Which PCO item" only means something to the plan
// trigger (a param). "Only on Sundays" applies to every trigger (a condition).
//
// Four is the whole list on purpose. If a rule needs more, the answer is a better
// trigger, not a query language.

import type { ConditionCtx, ConditionDef } from "../types/automation.js";
import { zonedMinuteOfDay, zonedParts } from "./app-timezone.js";

/** "HH:MM" -> minutes since midnight, or null. */
function hhmm(v: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const AUTOMATION_CONDITIONS: Record<string, ConditionDef> = {
  "service.is-live": {
    id: "service.is-live",
    label: "A service is live",
    params: [],
    holds: (ctx) => ctx.pcoLive?.mode === "item",
  },

  "service.type-is": {
    id: "service.type-is",
    label: "Service type is",
    params: [{ key: "serviceTypeId", label: "Service type", type: "enum", optionsFrom: "service-types" }],
    holds: (ctx, params) => {
      const want = String(params.serviceTypeId ?? "");
      return !!want && ctx.serviceTypeId === want;
    },
  },

  "time.day-of-week": {
    id: "time.day-of-week",
    label: "Day of week is",
    params: [{
      key: "days",
      label: "Days",
      type: "multi-enum",
      options: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => ({ value: String(i), label: d })),
    }],
    holds: (_ctx, params, now) => {
      const raw = String(params.days ?? "").trim();
      // Unconfigured must not silently block every rule that carries it.
      if (!raw) return true;
      const days = raw.split(",").map((d) => Number(d.trim()));
      // The APP's zone, not the host's: on a UTC server "Sunday" ends at 19:00
      // local, so an evening rule would read the wrong day for its last five hours.
      return days.includes(zonedParts(now).weekday);
    },
  },

  "time.between": {
    id: "time.between",
    label: "Time is between",
    params: [
      { key: "from", label: "From", type: "string", help: "HH:MM, 24-hour" },
      { key: "to", label: "To", type: "string", help: "HH:MM, 24-hour" },
    ],
    holds: (_ctx, params, now) => {
      const from = hhmm(params.from);
      const to = hhmm(params.to);
      if (from === null || to === null) return true; // unconfigured -> no opinion
      // Wall-clock in the APP's zone. An operator typing "18:30" means half six
      // where they are, never half six UTC.
      const cur = zonedMinuteOfDay(now);
      // A window may cross midnight (22:00 -> 02:00).
      return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
    },
  },
};

/** Every condition must hold. An unknown id fails CLOSED: a rule referencing a
 *  condition this build does not have must not fire. */
export function allConditionsHold(
  list: { id: string; params: Record<string, string | number> }[],
  ctx: ConditionCtx,
  now: number,
): boolean {
  for (const c of list) {
    const def = AUTOMATION_CONDITIONS[c.id];
    if (!def) return false;
    if (!def.holds(ctx, c.params, now)) return false;
  }
  return true;
}
