// One entry point for "an operator pressed a control on a console".
//
// Controls do not grow a parallel action list: they reference an ActionDef that
// already exists by id. A rule fires it on a trigger, an operator fires the same
// one on a press. That is the whole point of reusing the registry — one place to
// add a capability, two ways to reach it.

import { AUTOMATION_ACTIONS } from "./automation-actions.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
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
 *
 * A refusal is ALSO logged, here rather than in each caller: this is the one
 * entry point every press and every rule fire shares (see the file header), so
 * logging here covers a layout button, a Companion key and a future caller
 * alike, rather than depending on each one remembering to. Before this, a
 * same-origin operator pressing a refused layout button saw a toast and
 * nothing else — no line on /log, nothing in Activity — because the HTTP route
 * only ever logged non-same-origin (bearer-token) callers, and only who they
 * were, never whether the press actually did anything. Silent on success: a
 * working console would otherwise fill /log with a line per press.
 */
export async function invokeAction(
  id: string,
  params: Record<string, unknown> = {},
): Promise<ActionResult> {
  const def = AUTOMATION_ACTIONS[id];
  let result: ActionResult;
  if (!def) {
    result = { ok: false, detail: `unknown action "${id}"` };
  } else {
    try {
      result = await def.run(params, { simulate: false });
    } catch (e) {
      result = { ok: false, detail: errorMessage(e) };
    }
  }
  if (!result.ok) console.warn(`[action] ${scrub(id)} refused: ${scrub(result.detail)}`);
  return result;
}

/** Every action a control can be bound to, for the layout inspector's picker. */
export function invocableActions(): { id: string; label: string }[] {
  return Object.values(AUTOMATION_ACTIONS)
    .map((a) => ({ id: a.id, label: a.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
