// automation-log.ts — what the engine did, and what it declined to do.
//
// Suppressions are logged as loudly as fires. A suppressed rule is otherwise
// invisible, and "my rule did not run and I do not know why" is far harder to debug
// than "it ran twice".

import type { AutomationLogEntry } from "../types/automation.js";
import { broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";

/** Enough to cover several services; small enough to keep in memory and on disk. */
const CAP = 500;

const store = new DataStore<AutomationLogEntry[]>("automation-log.json", [], "runtime");
let entries: AutomationLogEntry[] = [];
let loaded = false;

export const automationLog = {
  async init(): Promise<void> {
    entries = await store.load();
    loaded = true;
  },

  add(entry: AutomationLogEntry): void {
    entries = [entry, ...entries].slice(0, CAP);
    broadcast("automation:log", { entries: entries.slice(0, 50) });
    // Fire-and-forget: losing the tail of the log on a hard kill is acceptable,
    // blocking a rule's dispatch on a disk write is not.
    if (loaded) void store.save(entries).catch(() => {});
  },

  list(): AutomationLogEntry[] {
    return entries;
  },

  async clear(): Promise<void> {
    entries = [];
    await store.save(entries);
    broadcast("automation:log", { entries: [] });
  },
};
