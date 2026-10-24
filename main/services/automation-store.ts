// Persisted rules + the two global flags.
//
// simulate defaults TRUE and disarmed defaults FALSE: a fresh install evaluates
// rules and logs what they would do, but cannot command anything.

import type { AutomationSettings, Rule } from "../types/automation.js";
import { DataStore } from "./data-store.js";
import { asArray, asObject, checked, optional, refuse, required } from "./restore-check.js";

/**
 * A restored rules file: each rule shaped the way POST /api/automation/rules
 * requires (a name, a trigger and an action), and every called cue passing the
 * same name checks addRule and updateRule apply — run against the restored set,
 * not the rules in memory it replaces. Param issues are NOT a refusal: a rule
 * with them lands as it was saved and shows Needs setup, which is what
 * automation-restore-keeps-issues.test.ts pins.
 */
const rulesRestoreCheck = checked(async (raw) => {
  const list = asArray(raw, "the rules");
  list.forEach((entry, i) => {
    const what = `rule ${i + 1}`;
    const rule = asObject(entry, what);
    required(rule.id, "string", `${what}'s id`);
    required(rule.name, "string", `${what}'s name`);
    for (const step of ["trigger", "action"] as const) {
      required(asObject(rule[step], `${what}'s ${step}`).id, "string", `${what}'s ${step} id`);
    }
    optional(rule.enabled, "boolean", `${what}'s enabled`);
    if (rule.conditions !== undefined) asArray(rule.conditions, `${what}'s conditions`);
  });
  // Lazily: the engine imports this store.
  const { automationEngine } = await import("./automation-engine.js");
  const [first] = automationEngine.cueProblemsIn(list as Rule[]);
  if (first) refuse(`rule "${first.rule}": ${first.problem}`);
  return list;
});

/** POST /api/automation/settings takes the two flags as booleans and nothing else. */
const settingsRestoreCheck = checked((raw) => {
  const s = asObject(raw, "the automation settings");
  optional(s.simulate, "boolean", "simulate");
  optional(s.disarmed, "boolean", "disarmed");
  return s;
});

const rules = new DataStore<Rule[]>("automation-rules.json", [], "config", { restoreCheck: rulesRestoreCheck });
const settings = new DataStore<AutomationSettings>(
  "automation-settings.json",
  {
    simulate: true,
    disarmed: false,
  },
  "config",
  { restoreCheck: settingsRestoreCheck },
);

export const automationStore = {
  /** Why automation-rules.json could not be read, while it cannot: see DataStore.unreadable(). */
  rulesUnreadable() {
    return rules.unreadable();
  },
  async loadRules(): Promise<Rule[]> {
    return rules.load();
  },
  async saveRules(next: Rule[]): Promise<void> {
    return rules.save(next);
  },
  async loadSettings(): Promise<AutomationSettings> {
    const s = await settings.load();
    return { simulate: s.simulate !== false, disarmed: s.disarmed === true };
  },
  async saveSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    return settings.update((c) => ({ ...c, ...patch }));
  },
};
