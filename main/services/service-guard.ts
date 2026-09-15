// service-guard.ts — the "allowed during a service" switch on a cue.
//
// PURE: no I/O, no engine. The settings page renders a single switch over the
// `service.is-not-live` condition — see automation-conditions.ts for what that
// condition actually holds and why it exists as its own entry rather than a
// negation. This module is only the view: whether a rule's condition list
// carries it, and the condition list after flipping the switch.

/** The condition id the switch is a view over. */
export const SERVICE_GUARD_CONDITION_ID = "service.is-not-live";

interface Condition {
  id: string;
  params: Record<string, string | number>;
}

/** Whether ANY of the rule's conditions is the service guard. */
export function hasServiceGuard(conditions: readonly Condition[]): boolean {
  return conditions.some((c) => c.id === SERVICE_GUARD_CONDITION_ID);
}

/**
 * The condition list after the switch is set to `guarded`.
 *
 * `guarded: true` (switch OFF — "refused while a service is live") adds ONE
 * instance, unless one is already there — the switch does not accumulate a
 * second copy from being toggled off twice.
 *
 * `guarded: false` (switch ON — "fires whenever it is called") removes EVERY
 * instance. A rule built by hand can carry the condition more than once —
 * nothing here stops that — so turning the switch on has to clear all of them,
 * or the rule would still refuse mid-service with the switch showing green.
 *
 * Every other condition is left in place and in order.
 */
export function withServiceGuard<C extends Condition>(conditions: readonly C[], guarded: boolean): C[] {
  const without = conditions.filter((c) => c.id !== SERVICE_GUARD_CONDITION_ID);
  if (!guarded) return without;
  if (without.length !== conditions.length) return conditions.slice() as C[];
  return [...without, { id: SERVICE_GUARD_CONDITION_ID, params: {} } as C];
}
