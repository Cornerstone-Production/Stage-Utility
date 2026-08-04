// automation-plan-times.ts — which plan time falls due in a tick's window.
//
// PURE. The live poller's `serverNow` values form contiguous, non-overlapping
// windows, so a half-open `(from, to]` test fires exactly once per plan time with
// no stored state — the same technique pco.item-due uses, and the reason a
// "before rehearsal" trigger needs no bookkeeping to avoid firing twice.
//
// Returns the plan time that came due rather than a boolean, so a caller can log
// WHICH one fired. That matters when a plan carries several rehearsals.

import type { PlanTimeDTO } from "../types/stage.js";

/**
 * The first plan time whose lead-time moment falls in `(fromMs, toMs]`.
 *
 * @param leadMinutes how far ahead of the time to fire.
 * @param timeTypes PCO `time_type` values to consider; empty means any.
 *
 * Fails CLOSED on anything malformed — a backwards window, an unset lead time, an
 * unparseable date. A trigger that guesses is worse than one that does not fire.
 */
export function planTimeDueIn(
  times: PlanTimeDTO[],
  fromMs: number,
  toMs: number,
  leadMinutes: number,
  timeTypes: string[],
): PlanTimeDTO | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const lead = Number(leadMinutes);
  if (!Number.isFinite(lead)) return null;

  const wanted = new Set((timeTypes ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean));

  for (const t of times ?? []) {
    if (wanted.size > 0 && !wanted.has(String(t?.timeType ?? "").toLowerCase())) continue;
    const start = Date.parse(t?.startsAt ?? "");
    if (!Number.isFinite(start)) continue;
    const due = start - lead * 60_000;
    if (due > fromMs && due <= toMs) return t;
  }
  return null;
}
