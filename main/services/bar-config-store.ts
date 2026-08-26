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
}

/** Empty rather than a hard-coded default: the RENDERER owns what an
 *  unconfigured bar looks like, so the default lives next to the item catalogue
 *  instead of being duplicated here where it would drift. */
const DEFAULT: BarConfig = { items: [] };

const store = new DataStore<BarConfig>("bar-config.json", DEFAULT, "config");

let cache: BarConfig = DEFAULT;

export const barConfigStore = {
  async init(): Promise<void> {
    cache = await store.load();
  },

  get(): BarConfig {
    return cache;
  },

  /** Replace the order. Awaited — this is the operator's arrangement, and a
   *  write that silently failed would read as saved until the next restart. */
  async set(items: string[]): Promise<BarConfig> {
    cache = { items };
    await store.save(cache);
    return cache;
  },
};
