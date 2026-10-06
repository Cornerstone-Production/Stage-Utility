// Which plans the ServiceCue page's switcher offers, where its arrows go, and what
// a pasted Planning Center link means. No React, no fetch.
//
// The list is the slots editor's own (`plans:upcoming`) and the stepping is its
// own too (plan-switcher-step.ts): this file only narrows the list to one
// service type and gives the arrows a plan-id interface. Nothing here decides an
// order; the server's order is the one the arrows walk.

import { formatClock } from "../lib/clock-format";
import { switcherSequence, stepTarget, type SwitcherEntry } from "../settings/sections/plan-switcher-step";

/** The plans of one service type, in the order the server sent them. */
export function plansOfType(plans: UpcomingPlan[], serviceTypeId: string | null): UpcomingPlan[] {
  return serviceTypeId ? plans.filter((p) => p.serviceTypeId === serviceTypeId) : [];
}

/**
 * The plan one arrow press goes to, or null when there is nowhere to go (the
 * signal to disable the arrow).
 *
 * Delegates to the editor's `stepTarget` over this type's plans alone, in its
 * `upcoming` mode: that mode walks plans by date and puts no Default stop in the
 * sequence, which is right here (a Default is a slots board, not a rundown).
 * A current plan the list does not carry — one more than a week old, or past the
 * window — is treated by `stepTarget` as sitting just before the first plan.
 */
export function stepPlan(typePlans: UpcomingPlan[], serviceTypeId: string, currentPlanId: string | null, direction: -1 | 1): string | null {
  const next = stepTarget(typePlans, "upcoming", { serviceTypeId, planId: currentPlanId }, direction);
  return next?.planId ?? null;
}

/** The stops of the dropdown: every plan of the type, nothing else. */
export function dropdownPlans(typePlans: UpcomingPlan[]): SwitcherEntry[] {
  return switcherSequence(typePlans, "upcoming", null);
}

export interface PlanLink {
  planId: string;
  /** Present only for the longer `/service_types/<id>/plans/<id>` spelling. */
  serviceTypeId: string | null;
}

// `…/plans/12345678`, `…/plans/12345678/live`, and the API-shaped
// `…/service_types/123/plans/12345678`. Digits only: a plan id is a number, and
// matching `plans/` against anything else would take "plans/new" for a plan.
const PLAN_LINK = /(?:service_types\/(\d+)\/)?plans\/(\d+)(?!\w)/;

/** The plan a pasted link names, or null when the text names none. */
export function parsePlanLink(text: string): PlanLink | null {
  const m = PLAN_LINK.exec(text.trim());
  if (!m) return null;
  return { planId: m[2]!, serviceTypeId: m[1] ?? null };
}

export type PastedPlan =
  /** The plan is, or is assumed to be, this page's service type's. */
  | { where: "here"; planId: string }
  /** The plan belongs to another service type; open that type's page on it. */
  | { where: "elsewhere"; planId: string; serviceTypeId: string; serviceTypeName: string | null };

/**
 * Where a pasted link's plan lives.
 *
 * Planning Center's plan URL carries no service type, and its API has no
 * plan-by-id lookup that does not already know one, so a plan is placed by the
 * lists the page already holds: the upcoming list across every service type the
 * switcher covers, or the type in the link when it is the long form. A plan in
 * neither, a past one or one outside the window, is taken as THIS type's: the
 * rundown read then answers whether it is, and the page says so when it is not.
 * The gap that leaves: another type's plan older than a week, or more than
 * sixty days out, pasted as the short link, reads as "not one of this type's
 * plans" rather than opening its own page.
 */
export function placePastedPlan(link: PlanLink, allPlans: UpcomingPlan[], thisTypeId: string): PastedPlan {
  const known = allPlans.find((p) => p.planId === link.planId);
  const typeId = known?.serviceTypeId ?? link.serviceTypeId ?? thisTypeId;
  if (typeId === thisTypeId) return { where: "here", planId: link.planId };
  return { where: "elsewhere", planId: link.planId, serviceTypeId: typeId, serviceTypeName: known?.serviceTypeName ?? null };
}

/** "Fri, Oct 9" and "8:00 PM" for a plan's sort_date, in the plan's own zone. Either is
 *  null when the plan has no date to format. */
export function planWhen(sortDate: string | null, timeZone: string | null): { date: string | null; time: string | null } {
  if (!sortDate || !Number.isFinite(Date.parse(sortDate))) return { date: null, time: null };
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(Date.parse(sortDate));
  return { date, time: formatClock(sortDate, { timeZone }) };
}
