// One entry point for "an operator pressed a control on a console".
//
// Controls do not grow a parallel action list: they reference an ActionDef that
// already exists by id. A rule fires it on a trigger, an operator fires the same
// one on a press. That is the whole point of reusing the registry — one place to
// add a capability, two ways to reach it.

import { AUTOMATION_ACTIONS } from "./automation-actions.js";
import { errorMessage } from "./errors.js";
import type { ActionResult } from "../types/automation.js";

/**
 * Run an action by id.
 *
 * NEVER throws. ActionDef already contracts never to throw, and this does not
 * trust that: a provider that breaks its contract must fail this one press, not
 * take down the console the operator is standing at mid-service. The failure is
 * RETURNED so the caller can show it — a catch that only logged would be the
 * repository's "do not swallow a failure" rule broken in the one place an
 * operator is watching.
 */
export async function invokeAction(
  id: string,
  params: Record<string, unknown> = {},
): Promise<ActionResult> {
  const def = AUTOMATION_ACTIONS[id];
  if (!def) {
    return { ok: false, detail: `unknown action "${id}"` };
  }
  try {
    return await def.run(params, { simulate: false });
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

/** Every action a control can be bound to, for the layout inspector's picker. */
export function invocableActions(): { id: string; label: string }[] {
  return Object.values(AUTOMATION_ACTIONS)
    .map((a) => ({ id: a.id, label: a.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
