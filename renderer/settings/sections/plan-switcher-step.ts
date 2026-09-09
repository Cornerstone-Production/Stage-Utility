// Where the plan switcher's arrows go. No React, no fetch, no DOM.
//
// The sequence the arrows walk is the one thing in this feature that decides
// which board an operator ends up editing, and it differs per mode. Kept as
// functions over plain data so both modes, both ends, and the Default entries
// can be driven directly.
//
// The arrows DO NOT WRAP. Walking off the end of the list and reappearing at the
// other end is how somebody editing next Sunday finds themselves on last
// Wednesday without noticing; the arrow is disabled at the end instead.

/** Which board the editor is pointed at. `planId: null` = the type's default. */
export interface EditingTarget {
  serviceTypeId: string | null;
  planId: string | null;
}

/** One stop on the switcher. */
export interface SwitcherEntry {
  serviceTypeId: string;
  serviceTypeName: string;
  /** null = this service type's DEFAULT board. */
  planId: string | null;
  sortDate: string | null;
  dates: string | null;
  title: string;
}

export function sameTarget(a: EditingTarget, b: EditingTarget): boolean {
  return a.serviceTypeId === b.serviceTypeId && a.planId === b.planId;
}

/** The stop for a service type's default board. */
export function defaultEntry(serviceTypeId: string, serviceTypeName: string): SwitcherEntry {
  return { serviceTypeId, serviceTypeName, planId: null, sortDate: null, dates: null, title: "Default" };
}

function planEntry(p: UpcomingPlan): SwitcherEntry {
  return {
    serviceTypeId: p.serviceTypeId,
    serviceTypeName: p.serviceTypeName,
    planId: p.planId,
    sortDate: p.sortDate,
    dates: p.dates,
    title: p.title,
  };
}

/** The name this list carries for a service type, or the id when it carries none. */
export function typeName(plans: UpcomingPlan[], serviceTypeId: string | null): string | null {
  if (!serviceTypeId) return null;
  return plans.find((p) => p.serviceTypeId === serviceTypeId)?.serviceTypeName ?? null;
}

/**
 * The stops the arrows walk, in order.
 *
 * `within-type`: the chosen type's DEFAULT first, then its plans by date. The
 * default is a stop, not a separate control — an operator stepping back from the
 * earliest plan lands on the board every week comes back to, which is the whole
 * point of the mode.
 *
 * `upcoming`: every allowed type's plans by date and nothing else. Defaults are
 * reachable from the dropdown; putting one between two dates would break the
 * "these arrows walk the week" reading the mode exists for.
 *
 * `plans` arrives already sorted by the server. Not re-sorted here: the order
 * the arrows walk and the order the server's list is in must be the same, and
 * two sorts are two chances for them to differ.
 */
export function switcherSequence(
  plans: UpcomingPlan[],
  mode: PlanSwitcherMode,
  serviceTypeId: string | null,
): SwitcherEntry[] {
  if (mode === "upcoming") return plans.map(planEntry);
  if (!serviceTypeId) return [];
  const name = typeName(plans, serviceTypeId) ?? "";
  return [
    defaultEntry(serviceTypeId, name),
    ...plans.filter((p) => p.serviceTypeId === serviceTypeId).map(planEntry),
  ];
}

/** How many plans the "upcoming" dropdown offers before the defaults group. */
export const UPCOMING_DROPDOWN_LIMIT = 10;

/**
 * What the middle control's dropdown lists.
 *
 * In `upcoming` this is a WINDOW of the sequence starting at the current target,
 * plus every type's default. The window always contains the current target — a
 * Select whose value is not among its options renders empty, and an operator
 * cannot tell that from "no plan selected".
 */
export function switcherOptions(
  plans: UpcomingPlan[],
  mode: PlanSwitcherMode,
  current: EditingTarget,
): { plans: SwitcherEntry[]; defaults: SwitcherEntry[] } {
  const seq = switcherSequence(plans, mode, current.serviceTypeId);
  if (mode === "within-type") return { plans: seq, defaults: [] };

  const at = seq.findIndex((e) => sameTarget(e, current));
  const from = at === -1 ? 0 : at;
  const window = seq.slice(from, from + UPCOMING_DROPDOWN_LIMIT);

  // One default per service type the list carries, in the order the types first
  // appear — which is date order, so the type you are about to run is near the top.
  const seen = new Set<string>();
  const defaults: SwitcherEntry[] = [];
  for (const p of plans) {
    if (seen.has(p.serviceTypeId)) continue;
    seen.add(p.serviceTypeId);
    defaults.push(defaultEntry(p.serviceTypeId, p.serviceTypeName));
  }
  // The current target when it is a default: it must be selectable in its own
  // dropdown even if the plan list has no row for its type.
  if (current.planId === null && current.serviceTypeId && !seen.has(current.serviceTypeId)) {
    defaults.push(defaultEntry(current.serviceTypeId, ""));
  }
  return { plans: window, defaults };
}

/**
 * One step along the sequence, or null when there is nowhere to go.
 *
 * Null is the signal to DISABLE the arrow. Returning the current target instead
 * would leave a button that looks live and does nothing, which this repo has
 * shipped before.
 *
 * A target that is not on the sequence at all — a default while in `upcoming`
 * mode, or a plan that has since dropped out of the window — is treated as
 * sitting immediately BEFORE its own type's first plan, so forward enters the
 * list at the type you were already editing rather than at the top of the week.
 */
export function stepTarget(
  plans: UpcomingPlan[],
  mode: PlanSwitcherMode,
  current: EditingTarget,
  direction: -1 | 1,
): EditingTarget | null {
  const seq = switcherSequence(plans, mode, current.serviceTypeId);
  const at = seq.findIndex((e) => sameTarget(e, current));

  let next: number;
  if (at !== -1) {
    next = at + direction;
  } else {
    const firstOfType = seq.findIndex((e) => e.serviceTypeId === current.serviceTypeId);
    const base = firstOfType === -1 ? 0 : firstOfType;
    next = direction > 0 ? base : base - 1;
  }

  const entry = seq[next];
  if (next < 0 || !entry) return null;
  return { serviceTypeId: entry.serviceTypeId, planId: entry.planId };
}

/**
 * A target as one string, for a native `<select>` value.
 *
 * Both halves are percent-encoded before being joined, so a service type or plan
 * id containing the separator cannot be decoded back into a different target —
 * which would point a save at a board nobody chose.
 */
export function encodeTarget(t: EditingTarget): string {
  return `${encodeURIComponent(t.serviceTypeId ?? "")}|${encodeURIComponent(t.planId ?? "")}`;
}

export function decodeTarget(v: string): EditingTarget {
  const [type = "", plan = ""] = v.split("|");
  return {
    serviceTypeId: decodeURIComponent(type) || null,
    planId: decodeURIComponent(plan) || null,
  };
}
