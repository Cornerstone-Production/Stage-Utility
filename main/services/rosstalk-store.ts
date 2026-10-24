// Persists RossTalk targets (config only — runtime connection/message never persist)
// and the global simulate flag.
//
// Simulate defaults to TRUE: a fresh install must not be able to command a switcher
// until someone deliberately turns simulation off.

import type { RossTalkTargetConfig } from "../types/rosstalk.js";
import { DataStore } from "./data-store.js";
import { asObject, checked, optional, targetEntries } from "./restore-check.js";

// The RossTalk target route checks no types on a PATCH; a restore holds the
// targets to the shape the OSC and wireless routes check for the same fields.
const targets = new DataStore<RossTalkTargetConfig[]>("rosstalk-targets.json", [], "config", {
  restoreCheck: checked((raw) => targetEntries(raw, "the RossTalk targets")),
});
// POST /api/rosstalk/simulate: a boolean.
const settings = new DataStore<{ simulate: boolean }>("rosstalk-settings.json", { simulate: true }, "config", {
  restoreCheck: checked((raw) => {
    const s = asObject(raw, "the RossTalk settings");
    optional(s.simulate, "boolean", "simulate");
    return s;
  }),
});

export const rosstalkStore = {
  async loadTargets(): Promise<RossTalkTargetConfig[]> {
    return targets.load();
  },
  async saveTargets(next: RossTalkTargetConfig[]): Promise<void> {
    return targets.save(next);
  },
  async loadSimulate(): Promise<boolean> {
    return (await settings.load()).simulate !== false;
  },
  async saveSimulate(simulate: boolean): Promise<void> {
    await settings.update((c) => ({ ...c, simulate }));
  },
};
