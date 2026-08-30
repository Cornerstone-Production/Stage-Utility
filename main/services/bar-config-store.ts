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
}

/** Empty rather than a hard-coded default: the RENDERER owns what an
 *  unconfigured bar looks like, so the default lives next to the item catalogue
 *  instead of being duplicated here where it would drift. */
const DEFAULT: BarConfig = { items: [], mobileItems: [] };

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
  };
}

export const barConfigStore = {
  async init(): Promise<void> {
    cache = normalize(await store.load());
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
    });
    await store.save(cache);
    return cache;
  },
};
