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
import { scrub } from "./scrub.js";
import { WriteQueue } from "./write-queue.js";

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
    throw new Error(`checklist ticks: refusing an unsafe plan id "${scrub(planId, 32)}"`);
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

/**
 * The load in flight, so two callers share ONE.
 *
 * init() reassigns `cache` outright. Two ticks arriving on a store that had
 * never been loaded — which is what every tick was, because nothing init'd this
 * store at boot — each saw `loaded === false` and each ran init(); the second
 * load landed on top of the first caller's tick and dropped it, with both HTTP
 * calls reporting success. Sharing the promise makes the reassignment happen
 * once no matter how many callers arrive cold.
 */
let loading: Promise<void> | null = null;

/**
 * Serialises tick writes.
 *
 * set() and clear() build the NEXT state as a copy and publish it only once the
 * file is on disk, which is a read-modify-write: two unserialised ticks would
 * each copy the same `cache` and the second would publish a copy that never saw
 * the first. Mutating a shared Map instead is what made that safe before, and
 * it is exactly what left a failed write reading as done.
 */
const writes = new WriteQueue();

function toFile(map: ReadonlyMap<string, Set<string>>): TicksFile {
  return Object.fromEntries([...map].map(([plan, keys]) => [plan, [...keys]])) as TicksFile;
}

/** A deep-enough copy to mutate without touching what `get`/`all` are reading. */
function copyOf(map: ReadonlyMap<string, Set<string>>): Map<string, Set<string>> {
  return new Map([...map].map(([plan, keys]) => [plan, new Set(keys)]));
}

/** Drop the oldest plans until only KEEP_PLANS remain. */
function prune(map: Map<string, Set<string>>): void {
  while (map.size > KEEP_PLANS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loading ??= (async () => {
    const file = await store.load();
    cache = new Map(Object.entries(file).map(([plan, keys]) => [plan, new Set(keys)]));
    loaded = true;
  })();
  try {
    await loading;
  } finally {
    // Cleared whichever way it went: a load that failed must not be remembered
    // as still in flight, or every later caller would await a dead promise.
    loading = null;
  }
}

/**
 * Save, and say so on `/log` if it did not work.
 *
 * Rethrown, never swallowed: the caller turns this into an HTTP error the
 * operator sees in the moment. The log line is for the other half of it — a full
 * SD card at 9am on a Sunday shows up as a tick that will not stay ticked, and
 * `/log` is the only place that says why.
 */
async function saveOrReport(
  next: Map<string, Set<string>>,
  action: string,
  planId: string,
  key?: string,
): Promise<void> {
  try {
    await store.save(toFile(next));
  } catch (err) {
    // The plan id and the row label both arrive from the wire, and `/log` is a
    // LAN-visible page where a newline in either forges a record. Scrubbed HERE
    // rather than at the call sites so a third caller cannot reintroduce the
    // hole by composing its own string — the only thing a caller passes is the
    // raw value.
    const what = key === undefined
      ? `${action} plan ${scrub(planId, 64)}`
      : `${action} "${scrub(key, 80)}" on plan ${scrub(planId, 64)}`;
    // `what` is an ARGUMENT, never the format string. console.error treats its
    // first argument as a format string, so a row label containing `%s` would
    // swallow `err` into the message and the operator would be told a save
    // failed without being told why. Scrubbing does not help — `%` is a
    // perfectly ordinary character in a checklist row.
    console.error("[checklist] could not save, NOT recorded:", what, err);
    throw err;
  }
}

export const checklistTicksStore = {
  /**
   * Read the file into memory. Called at boot beside the other stores, which is
   * what makes `get` truthful on the first render after a restart — before that
   * it answered from an empty Map and reported every completed job as not done,
   * so the checklist asked for the whole list to be redone.
   *
   * Idempotent, and safe to call concurrently with a tick.
   */
  async init(): Promise<void> {
    await ensureLoaded();
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
    return writes.enqueue(async () => {
      await ensureLoaded();

      const next = copyOf(cache);
      // Re-inserting moves this plan to the end of the Map, so the plan being
      // worked on is never the one prune drops.
      const keys = next.get(planId) ?? new Set<string>();
      next.delete(planId);
      next.set(planId, keys);

      if (done) keys.add(key);
      else keys.delete(key);

      prune(next);
      // The file first, the live state second. Mutating first meant a write that
      // failed — a full SD card is the usual way — still left the broadcast, the
      // API and the next render calling the row done, which is the one thing
      // this store must never say when it did not save.
      await saveOrReport(next, done ? "tick" : "untick", planId, key);
      cache = next;
    });
  },

  /** Clear one plan's ticks — the manual "start this week over". */
  async clear(planId: string): Promise<void> {
    assertSafePlanId(planId);
    return writes.enqueue(async () => {
      await ensureLoaded();
      if (!cache.has(planId)) return;
      const next = copyOf(cache);
      next.delete(planId);
      await saveOrReport(next, "clear", planId);
      cache = next;
    });
  },
};
