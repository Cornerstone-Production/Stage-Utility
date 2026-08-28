// Which checklist rows have been ticked, for which plan.
//
// Classified "runtime", NOT "config", and the distinction is the whole design.
// The checklist itself is the operator's work — but it lives in Planning Center,
// where they wrote it, and a restore puts it back by definition. What is stored
// here is an observation about one week: somebody ticked "batteries fresh" on
// the plan for the 31st. Restoring a six-month-old backup and having last
// winter's ticks reappear against this Sunday's plan would be worse than
// starting empty.
//
// Buckets are per PLAN, which is what makes "ticks clear when the next service
// starts" true without a scheduled job to clear them: a new plan is a new
// bucket, so the old ticks are simply not the ones being read. They are kept
// rather than deleted so that flipping back to last week's plan — to check what
// was done, or because somebody selected the wrong one — still shows what
// happened, instead of silently reporting that nobody did anything.

import { DataStore } from "./data-store.js";

/** planId -> the item keys ticked on that plan. */
type TicksFile = Record<string, string[]>;

/**
 * How many plans' ticks to keep.
 *
 * Small on purpose: this is a rolling record of recent weeks, not history. Four
 * covers "last month" for a weekly service, which is well past the point anyone
 * looks back.
 */
const KEEP_PLANS = 4;

/**
 * Plan ids as PCO issues them.
 *
 * The id is used as a property name in the JSON file, so it gets the same
 * treatment every other client-influenced key in this codebase gets. PCO's own
 * ids are numeric strings; anything else is refused rather than cleaned, because
 * a "cleaned" id would write ticks to the wrong plan.
 */
const SAFE_PLAN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_IDS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafePlanId(planId: string): void {
  if (!SAFE_PLAN_ID.test(planId) || FORBIDDEN_IDS.has(planId)) {
    throw new Error(`checklist ticks: refusing an unsafe plan id "${planId.slice(0, 32)}"`);
  }
}

const store = new DataStore<TicksFile>("checklist-ticks.json", {}, "runtime");

/**
 * A Map, so a plan id from the wire is an ordinary entry and never a prototype
 * key. Insertion order is also what `prune` uses to decide which plan is oldest,
 * which a plain object would only give by accident.
 */
let cache = new Map<string, Set<string>>();
let loaded = false;

function toFile(map: ReadonlyMap<string, Set<string>>): TicksFile {
  return Object.fromEntries([...map].map(([plan, keys]) => [plan, [...keys]])) as TicksFile;
}

/** Drop the oldest plans until only KEEP_PLANS remain. */
function prune(): void {
  while (cache.size > KEEP_PLANS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

export const checklistTicksStore = {
  async init(): Promise<void> {
    const file = await store.load();
    cache = new Map(Object.entries(file).map(([plan, keys]) => [plan, new Set(keys)]));
    loaded = true;
  },

  /** The keys ticked on this plan. Empty for a plan nobody has touched. */
  get(planId: string): string[] {
    return [...(cache.get(planId) ?? [])];
  },

  /** Everything, for the state broadcast. */
  all(): TicksFile {
    return toFile(cache);
  },

  /**
   * Tick or untick one row.
   *
   * Awaited, and the failure is returned to the caller rather than logged: a
   * tick that looked saved and was not is how somebody skips a job on Sunday
   * believing it was done.
   */
  async set(planId: string, key: string, done: boolean): Promise<void> {
    assertSafePlanId(planId);
    if (!loaded) await checklistTicksStore.init();

    // Re-inserting moves this plan to the end of the Map, so the plan being
    // worked on is never the one prune drops.
    const keys = cache.get(planId) ?? new Set<string>();
    cache.delete(planId);
    cache.set(planId, keys);

    if (done) keys.add(key);
    else keys.delete(key);

    prune();
    await store.save(toFile(cache));
  },

  /** Clear one plan's ticks — the manual "start this week over". */
  async clear(planId: string): Promise<void> {
    assertSafePlanId(planId);
    if (!loaded) await checklistTicksStore.init();
    if (!cache.delete(planId)) return;
    await store.save(toFile(cache));
  },
};
