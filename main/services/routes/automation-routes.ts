// automation-routes.ts — rules, registries, settings, activity log.
//
// Every route must finish responding before it returns (see RouteCtx).

import { errorMessage } from "../errors.js";
import { type RouteCtx, error, json, readBody } from "./context.js";
import { AUTOMATION_ACTIONS } from "../automation-actions.js";
import { invokeAction } from "../action-invoke.js";
import { AUTOMATION_CONDITIONS } from "../automation-conditions.js";
import { automationEngine } from "../automation-engine.js";
import { automationLog } from "../automation-log.js";
import { AUTOMATION_TRIGGERS } from "../automation-triggers.js";
import {
  fieldsNeedAttention,
  ruleIssues,
  type RuleIssue,
  type RuleStepsLike,
  type StepSpecLookup,
} from "../automation-param-validation.js";
import { bearerOf, cueTokens, isSameOriginBrowser, refusalReason } from "../cue-tokens.js";
import { propresenterManager } from "../propresenter-service.js";
import { scrub } from "../scrub.js";
import { stageController } from "../stage-controller.js";

/** Strip functions — didFire/holds/run cannot cross the wire. */
const shape = (o: Record<string, { id: string; label: string; params: unknown; help?: string }>) =>
  Object.values(o).map(({ id, label, params, help }) => ({ id, label, params, help }));

/**
 * Every trigger/condition/action's own label and params, off the SAME three
 * registries the engine fires from — not a copy, so a param added to a
 * provider is validated here the moment it exists.
 */
const specLookup: StepSpecLookup = (kind, id) => {
  const def =
    kind === "trigger" ? AUTOMATION_TRIGGERS[id] : kind === "condition" ? AUTOMATION_CONDITIONS[id] : AUTOMATION_ACTIONS[id];
  return def ? { label: def.label, params: def.params } : null;
};

/**
 * A rule's issues against the CURRENT registry — authoritative, so a stale
 * browser tab holding an old registry cannot save around a field this
 * version now requires. Never mutates anything; a caller decides what to do
 * with an empty or non-empty result. See docs/automation.md.
 */
function issuesFor(rule: RuleStepsLike): RuleIssue[] {
  return ruleIssues(rule, specLookup);
}

export async function automationRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  // POST /api/action/invoke — { actionId, params? }
  // An operator pressed a control on a console. The SAME registry the automation
  // engine fires from: one place to add a capability, two ways to reach it.
  if (method === "POST" && pathname === "/api/action/invoke") {
    // A write from the app's own pages carries an Origin naming this server, and
    // remote-server has already refused it if that Origin was somebody else's —
    // so a browser here is an operator at the console and passes as it always
    // has. Anything else is curl, a script, or a voice assistant, and this route
    // runs actions that press buttons on real gear: it needs the same bearer
    // token a cue call needs. See isSameOriginBrowser. docs/reference/api.md.
    if (!isSameOriginBrowser(req.headers)) {
      const caller = await cueTokens.verify(bearerOf(req.headers.authorization));
      if (!caller) {
        console.warn(`[cues] refused POST /api/action/invoke: ${scrub(refusalReason(req.headers.authorization))}`);
        error(res, "A bearer token is required for a request with no Origin", 401);
        return;
      }
      console.log(`[cues] action/invoke by ${scrub(caller.label)}`);
    }
    const body = await readBody(req) as Record<string, unknown>;
    if (typeof body.actionId !== "string") {
      error(res, "body.actionId (string) required");
      return;
    }
    const params = (body.params && typeof body.params === "object" && !Array.isArray(body.params))
      ? body.params as Record<string, unknown>
      : {};
    // invokeAction never throws: a failure returns { ok: false, detail } and is
    // reported to the operator rather than swallowed or turned into a 500.
    json(res, await invokeAction(body.actionId, params));
    return;
  }

  if (method === "GET" && pathname === "/api/automation/registry") {
    json(res, {
      triggers: Object.values(AUTOMATION_TRIGGERS).map(({ id, label, channel, params, help }) => ({ id, label, channel, params, help })),
      conditions: shape(AUTOMATION_CONDITIONS),
      actions: shape(AUTOMATION_ACTIONS),
    });
    return;
  }

  // Options for params declaring optionsFrom: "plan-items". Served from the live
  // payload's own item clock rather than a fresh PCO call, so the dropdown offers
  // exactly what the trigger will match against — a title that appears here is one
  // the rule can actually fire on. Empty (never an error) when no plan is loaded:
  // the rule editor has to open regardless.
  if (method === "GET" && pathname === "/api/automation/plan-items") {
    const schedule = stageController.getLastLive()?.itemSchedule ?? [];
    // The VALUE is the title, not the id. Ids are new objects every plan, so an id
    // picked on Tuesday is dead by Sunday.
    json(res, { items: schedule.map((i) => ({ value: i.title, label: i.title, dueAt: i.dueAt, exact: i.exact })) });
    return;
  }

  // Options for params declaring optionsFrom: "propresenter-instances". The
  // manager's own list, so what the dropdown offers is exactly what a rule can
  // address — including the primary, whose id is "default" everywhere else a
  // layout object names an instance.
  if (method === "GET" && pathname === "/api/automation/propresenter-instances") {
    json(res, { items: propresenterManager.listInstances().map((i) => ({ value: i.id, label: i.name })) });
    return;
  }

  // Options for params declaring optionsFrom: "propresenter-macros", unioned by
  // NAME across every configured instance. The value IS the name: uuids are
  // per-machine and die on a re-import, so a macro picked on Tuesday would be
  // gone by Sunday — the same reasoning as plan-items above.
  //
  // Empty (never an error) when a booth machine is off: the rule editor has to
  // open regardless. The label says which instance a name is missing from, so
  // an operator can see that a macro only half the building has is only half
  // the building's.
  //
  // `unreachable` IS CARRIED, and was being destructured away. Two consequences,
  // the second worse than the first: a single-instance site with the machine off
  // rendered "Pick one…" and nothing else, with nothing anywhere saying why —
  // and with two instances where one is off, `instanceCount` counts every
  // instance with a target INCLUDING the one that did not answer, so every macro
  // the reachable machine reported was labelled "SONG INTRO (Main only)". That is
  // a positive false statement — the macro does not exist on the other machine —
  // when the truth is that the other machine was not asked successfully.
  //
  // So the suffix is suppressed outright while anything is unreachable. "Only"
  // is a claim about the machines that ANSWERED, and it cannot be made about a
  // set that is incomplete.
  if (method === "GET" && pathname === "/api/automation/propresenter-macros") {
    const { names, instanceCount, unreachable } = await propresenterManager.allMacros();
    const complete = unreachable.length === 0;
    json(res, {
      items: names.map(({ name, instances }) => ({
        value: name,
        label:
          complete && instanceCount > 1 && instances.length < instanceCount
            ? `${name} (${instances.join(", ")} only)`
            : name,
      })),
      // For the editor to say WHY a list is short or empty. Named instances, not
      // a count: "Chapel did not answer" is actionable and "1 unreachable" is not.
      unreachable,
    });
    return;
  }

  // GET's issues are read-only and computed fresh every call — never stored,
  // never written back. This is what lets a restore or an import land a rule
  // with problems exactly as saved (enabled, if that is what was saved) while
  // the list still shows "Needs setup": the badge comes from here, not from a
  // flag the write path set.
  if (method === "GET" && pathname === "/api/automation/rules") {
    const rules = automationEngine.listRules().map((rule) => ({ ...rule, issues: issuesFor(rule) }));
    json(res, { rules, settings: automationEngine.getSettings() });
    return;
  }

  if (method === "POST" && pathname === "/api/automation/rules") {
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body.name !== "string" || !body.trigger || !body.action) {
      error(res, "body.name, body.trigger and body.action are required");
      return;
    }
    const issues = issuesFor(body as unknown as RuleStepsLike);
    // An explicit ask to CREATE it enabled while it still has issues is refused
    // outright — nothing this app creates today does that (Add rule always
    // starts disabled, and the Companion imports always fill every field), so
    // this is a stale-tab or hand-built-request backstop.
    if (issues.length > 0 && body.enabled === true) {
      json(res, { error: "This rule needs setup before it can be turned on", code: "invalid-params", issues }, 409);
      return;
    }
    // Otherwise issues never block the save — they force it OFF instead, per
    // docs/automation.md: "saved turned off, it runs once these are fixed".
    const toSave = issues.length > 0 ? { ...body, enabled: false } : body;
    try {
      const rule = await automationEngine.addRule(toSave as never);
      if (issues.length > 0) {
        console.log(`[automation] rule "${scrub(rule.name)}" saved turned off: ${fieldsNeedAttention(issues.length)}`);
      }
      json(res, { rule, issues }, 201);
    } catch (err) {
      // A duplicate or malformed cue name is the caller's problem, not a 500.
      error(res, errorMessage(err), 400);
    }
    return;
  }

  const idMatch = pathname.match(/^\/api\/automation\/rules\/([^/]+)$/);
  if (method === "PATCH" && idMatch) {
    const body = (await readBody(req)) as Record<string, unknown>;
    const existing = automationEngine.listRules().find((r) => r.id === idMatch[1]);
    if (!existing) {
      error(res, `Automation: unknown rule ${idMatch[1]}`, 400);
      return;
    }
    const candidate = { ...existing, ...body } as unknown as RuleStepsLike;
    const issues = issuesFor(candidate);
    // The one refusal: a patch whose ONLY content is turning a broken rule ON
    // — the rules list's switch (`patch: { enabled: true }`, nothing else), or
    // an editor Save where nothing else was touched either. A patch that ALSO
    // fixes fields is a normal Save with the Enabled switch left on, and must
    // not be bounced just because one OTHER field is still bad — it saves,
    // turned off, same as any other save with issues (see below).
    //
    // This route is the ONLY caller that can reach here: the Companion
    // reconcile pass and the state-learning probe both patch a rule through
    // automationEngine.updateRule directly, never through HTTP, and neither
    // patch ever touches `enabled` — so a legacy rule this version newly
    // considers invalid keeps firing exactly as it did before this feature,
    // right up until an operator next saves or enables it by hand. That is
    // "enforced when next saved or enabled", not a regression on upgrade.
    const onlyAsksToEnable = body.enabled === true && Object.keys(body).length === 1;
    if (issues.length > 0 && onlyAsksToEnable) {
      console.warn(
        `[automation] refused to enable "${scrub(existing.name)}": ${fieldsNeedAttention(issues.length)}`,
      );
      json(
        res,
        {
          error: `Can't turn on "${existing.name}": ${fieldsNeedAttention(issues.length)}. Open it to fix them.`,
          code: "invalid-params",
          issues,
        },
        409,
      );
      return;
    }
    const patch = issues.length > 0 ? { ...body, enabled: false } : body;
    try {
      await automationEngine.updateRule(idMatch[1], patch as never);
      const rule = automationEngine.listRules().find((r) => r.id === idMatch[1])!;
      if (issues.length > 0) {
        console.log(`[automation] rule "${scrub(rule.name)}" saved turned off: ${fieldsNeedAttention(issues.length)}`);
      }
      json(res, { rule, issues: issuesFor(rule) });
    } catch (err) {
      error(res, errorMessage(err), 400);
    }
    return;
  }
  if (method === "DELETE" && idMatch) {
    json(res, await automationEngine.removeRule(idMatch[1]));
    return;
  }

  const testMatch = pathname.match(/^\/api\/automation\/rules\/([^/]+)\/test$/);
  if (method === "POST" && testMatch) {
    try {
      json(res, await automationEngine.testFire(testMatch[1]));
    } catch (err) {
      error(res, errorMessage(err), 400);
    }
    return;
  }

  if (method === "GET" && pathname === "/api/automation/settings") {
    json(res, automationEngine.getSettings());
    return;
  }
  if (method === "POST" && pathname === "/api/automation/settings") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const patch: Record<string, boolean> = {};
    if (typeof body.simulate === "boolean") patch.simulate = body.simulate;
    if (typeof body.disarmed === "boolean") patch.disarmed = body.disarmed;
    json(res, await automationEngine.setSettings(patch));
    return;
  }

  if (method === "GET" && pathname === "/api/automation/log") {
    json(res, { entries: automationLog.list() });
    return;
  }
  if (method === "DELETE" && pathname === "/api/automation/log") {
    await automationLog.clear();
    json(res, { ok: true });
    return;
  }
}
