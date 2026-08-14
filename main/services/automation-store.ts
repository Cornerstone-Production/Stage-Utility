// Persisted rules + the two global flags.
//
// simulate defaults TRUE and disarmed defaults FALSE: a fresh install evaluates
// rules and logs what they would do, but cannot command anything.

import type { AutomationSettings, Rule } from "../types/automation.js";
import { DataStore } from "./data-store.js";

const rules = new DataStore<Rule[]>("automation-rules.json", [], "config");
const settings = new DataStore<AutomationSettings>(
  "automation-settings.json",
  {
    simulate: true,
    disarmed: false,
  },
  "config",
);

export const automationStore = {
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
