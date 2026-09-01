// Which context-bar items appear, and in what order.
//
// Operator config, so "config": someone arranged this bar to suit how they work,
// and losing it to a reinstall is losing their setup. Being config is also what
// puts it in every backup — the allowlist is derived from this classification.
//
// GLOBAL, not per-device, consistent with the server-as-source-of-truth model.
// That is deliberate: the bar is shared context, and two operators looking at
// two machines should be reading the same strip.

import { DataStore } from "./data-store.js";

export interface BarConfig {
  /** Item ids, in display order. Unknown ids are skipped by the renderer, so a
   *  downgrade or a removed integration cannot leave a hole in the bar. */
  items: string[];
  /**
   * The phone's own set, chosen independently of the one above.
   *
   * A SECOND LIST IN THE SAME STORE, deliberately, rather than a second store.
   * A store has to declare itself config and be carried by a snapshot, and the
   * standing failure in this repo is a new store that nobody remembers to
   * register — so it is silently absent from every backup until an operator
   * restores one and finds their work gone. A field inside a file that is
   * already classified config cannot go missing: it rides in bar-config.json,
   * which config-snapshot.test.ts already asserts by name.
   *
   * EMPTY MEANS "FOLLOW THE DESKTOP BAR", not "an empty bar on a phone" — the
   * same convention `items` already uses, where empty means the renderer
   * decides. It cannot be ambiguous: `normalizeBarRows` guarantees anything the
   * configurator saves carries at least one spacer, so a saved mobile set is
   * never the empty array.
   *
   * That default is what stops an upgrade moving anybody's bar. An operator who
   * put integration health on their strip wants it on the phone they carry away
   * from the console most of all; a curated default would have quietly taken it
   * off for them.
   */
  mobileItems: string[];
  /**
   * Which rewrites this file has already had. Absent means "written before there
   * were any", which is every bar-config.json in existence before SCHEMA 1.
   *
   * A STAMP, not a guess from the contents. See `splitServiceType` for why the
   * contents cannot answer it.
   */
  schema?: number;
}

/**
 * The current shape of a saved bar.
 *
 *   1  The single "Service type and plan" item became two items, `service-type`
 *      and `plan`, so either can be placed without the other.
 */
const SCHEMA = 1;

/** Empty rather than a hard-coded default: the RENDERER owns what an
 *  unconfigured bar looks like, so the default lives next to the item catalogue
 *  instead of being duplicated here where it would drift.
 *
 *  Stamped with the current schema so a FRESH install needs no migration and no
 *  write: there is nothing older to rewrite. */
const DEFAULT: BarConfig = { items: [], mobileItems: [], schema: SCHEMA };

const store = new DataStore<BarConfig>("bar-config.json", DEFAULT, "config");

let cache: BarConfig = DEFAULT;

/**
 * Fill in a field a file written by an older build does not have.
 *
 * DataStore parses the JSON and casts it — it does NOT merge the default in — so
 * every bar-config.json saved before the phone got its own set has no
 * `mobileItems` at all. Left alone that is a `string[]` the type checker
 * believes in and the renderer would read `undefined.length` off. Healed here,
 * on the one path everything else reads through.
 */
function normalize(raw: BarConfig): BarConfig {
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    mobileItems: Array.isArray(raw.mobileItems) ? raw.mobileItems : [],
    schema: typeof raw.schema === "number" ? raw.schema : undefined,
  };
}

/**
 * SCHEMA 1 — rewrite the old compound `plan` item as the pair that replaced it.
 *
 * `plan` used to draw the service-type name AND the plan title. It now draws the
 * title alone, and `service-type` draws the other half. Every bar saved before
 * that split names `plan` and expects both readings, so the pair is written in
 * where the one item was: nobody's bar loses a reading to a refactor.
 *
 * These two ids are renderer vocabulary — the catalogue is BAR_ITEMS in
 * renderer/app/bar-items.tsx — but the migration belongs to the FILE, so it runs
 * once, on the server, and is stamped. Doing it on read instead cannot be made
 * safe: an operator who then drags the service type off their bar saves a list
 * naming `plan` alone, and a read-time rule has no way to tell that from a bar
 * that was never migrated. It would put the item straight back, every load, and
 * the removal would look broken rather than undone.
 *
 * IDEMPOTENT ON ITS OWN as well as behind the stamp, and the two cover different
 * failures. The stamp is what stops the rewrite re-running after a deliberate
 * removal. This is what stops a double insert if the stamp is ever lost — a
 * hand-edited file, or a config snapshot restored from a build in between — where
 * `["service-type","plan"]` must come back unchanged rather than as
 * `["service-type","service-type","plan"]`.
 */
export function splitServiceType(items: readonly string[]): string[] {
  return items.flatMap((id, i) =>
    id === "plan" && items[i - 1] !== "service-type" ? ["service-type", id] : [id],
  );
}

export const barConfigStore = {
  /**
   * Load the saved bar, rewriting it if an older build wrote it.
   *
   * Returns the migration's failure rather than throwing it, and rather than
   * logging and moving on. A data directory that has filled up is a real state,
   * and it must not take the server down over the context bar: the rewrite is
   * already in `cache`, so this session's bar is correct, and the next start
   * tries the write again. The caller decides what to tell the operator.
   */
  async init(): Promise<Error | null> {
    const saved = normalize(await store.load());
    if (saved.schema === SCHEMA) {
      cache = saved;
      return null;
    }

    cache = {
      items: splitServiceType(saved.items),
      mobileItems: splitServiceType(saved.mobileItems),
      schema: SCHEMA,
    };
    // Only when a bar actually changed. Every install crosses this once and most
    // of them have nothing to rewrite; a line on every start would be noise, and
    // a line on the one start that moved somebody's bar is the thing you want to
    // find at 9am. No operator data in it — counts only.
    if (cache.items.length !== saved.items.length || cache.mobileItems.length !== saved.mobileItems.length) {
      console.log(
        `[bar-config] split the service type out of the plan item: desktop ${saved.items.length}→${cache.items.length} row(s), phone ${saved.mobileItems.length}→${cache.mobileItems.length}`,
      );
    }
    // Stamped even when nothing changed. An unconfigured install has no `plan`
    // to rewrite, but leaving it unstamped would mean the next bar it saves —
    // one that deliberately carries `plan` alone — gets "migrated" on the
    // following start.
    try {
      await store.save(cache);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
    return null;
  },

  get(): BarConfig {
    return cache;
  },

  /**
   * Replace one or both orders. Awaited — this is the operator's arrangement,
   * and a write that silently failed would read as saved until the next restart.
   *
   * Each list is optional and an omitted one is KEPT. The configurator edits one
   * set at a time, and a caller that had to send both would send whatever it
   * last read for the other — so a second operator's edit to the desktop bar
   * would be undone by the next save from a phone.
   */
  async set(next: Partial<BarConfig>): Promise<BarConfig> {
    // KEY BY KEY, NOT BY SPREAD. `{ ...cache, ...next }` looks like it keeps what
    // the caller left out, and does not: a key that is PRESENT AND UNDEFINED —
    // which is exactly what `{ items: body.items }` produces when the body had no
    // `items` — overwrites the kept value with undefined, and normalising then
    // turned it into an empty list. Saving a phone set wiped the desktop bar and
    // every operator's arrangement with it. Guarded in bar-config-store.test.ts.
    cache = normalize({
      items: next.items ?? cache.items,
      mobileItems: next.mobileItems ?? cache.mobileItems,
      // Re-stamped on every write, not carried from `cache`. What this file now
      // holds is what the configurator just saved against the current catalogue,
      // whether or not `init` managed to write its stamp — and an unstamped save
      // would be migrated on the next start, putting back a service type the
      // operator had just dragged off.
      schema: SCHEMA,
    });
    await store.save(cache);
    return cache;
  },
};
