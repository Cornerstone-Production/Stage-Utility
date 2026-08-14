// Persists RossTalk targets (config only — runtime connection/message never persist)
// and the global simulate flag.
//
// Simulate defaults to TRUE: a fresh install must not be able to command a switcher
// until someone deliberately turns simulation off.

import type { RossTalkTargetConfig } from "../types/rosstalk.js";
import { DataStore } from "./data-store.js";

const targets = new DataStore<RossTalkTargetConfig[]>("rosstalk-targets.json", [], "config");
const settings = new DataStore<{ simulate: boolean }>("rosstalk-settings.json", { simulate: true }, "config");

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
