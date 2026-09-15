// automation-log.ts — what the engine did, and what it declined to do.
//
// Suppressions are logged as loudly as fires. A suppressed rule is otherwise
// invisible, and "my rule did not run and I do not know why" is far harder to debug
// than "it ran twice".

import type { AutomationLogEntry } from "../types/automation.js";
import { broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";
import { scrubError } from "./scrub.js";

/** Enough to cover several services; small enough to keep in memory and on disk. */
const CAP = 500;

const store = new DataStore<AutomationLogEntry[]>("automation-log.json", [], "runtime");
let entries: AutomationLogEntry[] = [];
let loaded = false;
/** The save in flight from the most recent add(), if any. See whenIdle(). Never
 *  rejects — the catch below always resolves it — so nothing awaiting it needs
 *  a try/catch of its own. */
let saving: Promise<void> = Promise.resolve();

export const automationLog = {
  async init(): Promise<void> {
    entries = await store.load();
    loaded = true;
  },

  add(entry: AutomationLogEntry): void {
    entries = [entry, ...entries].slice(0, CAP);
    broadcast("automation:log", { entries: entries.slice(0, 50) });
    // Fire-and-forget: losing the tail of the log on a hard kill is acceptable,
    // blocking a rule's dispatch on a disk write is not. NOT swallowed, though:
    // an empty catch here used to mean a disk-full or a permissions change
    // silently stopped every future entry from persisting, forever, with
    // nothing on /log ever saying so — while /automation, served from the
    // in-memory list above, kept looking completely normal. Logged rather than
    // handed back to a caller: add() is called from deep inside the engine's
    // rule dispatch, and blocking dispatch on the write is exactly what
    // "fire-and-forget" above exists to avoid.
    if (loaded) {
      saving = store.save(entries).catch((err: unknown) => {
        console.error(
          "[automation-log] could not persist automation-log.json — this entry and any " +
            "since are in memory only until a save succeeds:",
          scrubError(err),
        );
      });
    }
  },

  list(): AutomationLogEntry[] {
    return entries;
  },

  async clear(): Promise<void> {
    entries = [];
    await store.save(entries);
    broadcast("automation:log", { entries: [] });
  },

  /**
   * Resolves once the save started by the most recent add() has settled,
   * success or failure. Never rejects.
   *
   * add() deliberately does not await its own write (see there), so a caller
   * that needs the write to have LANDED has nothing else to wait on. Without
   * this, a test tearing down its data directory the moment its assertions
   * pass could run `fs.rm(TMP, { recursive: true, force: true })` while a save
   * was still in flight: the write would recreate automation-log.json after
   * rm() had just emptied the directory, and rm's own directory removal would
   * then fail ENOTEMPTY.
   */
  whenIdle(): Promise<void> {
    return saving;
  },
};
