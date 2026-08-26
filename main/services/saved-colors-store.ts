// Colours the operator has kept.
//
// The picker ships with the app's own palette, which is what a widget should
// usually be. This is the other half: the church's own colours — a series
// green, a sponsor's blue, whatever last year's stage design used — mixed once
// and reachable from every colour control afterwards.
//
// Operator config, so "config": somebody mixed these deliberately, and losing
// them to a reinstall is losing their work. Being config is also what puts them
// in every backup — the allowlist is derived from this classification.
//
// GLOBAL, not per-browser. localStorage was the cheaper option and the wrong
// one: the same person sets a layout up on a laptop and touches it up on a
// tablet by the desk, and a palette that existed on one of them would read as
// having lost the colours rather than as being per-device.

import { DataStore } from "./data-store.js";

/** CSS colour strings, newest first — a colour just saved is where the eye is. */
const DEFAULT: string[] = [];

const store = new DataStore<string[]>("saved-colors.json", DEFAULT, "config");

let cache: string[] = DEFAULT;

/**
 * A ceiling, and it is not a silent one.
 *
 * The list has to stop somewhere or the picker grows a scrolling wall of
 * near-identical greys. At the cap the OLDEST goes — and the caller is told, so
 * the UI can say so rather than quietly dropping something the operator saved.
 */
export const MAX_SAVED_COLORS = 24;

export const savedColorsStore = {
  async init(): Promise<void> {
    const loaded = await store.load();
    cache = Array.isArray(loaded) ? loaded.filter((c) => typeof c === "string") : [];
  },

  all(): string[] {
    return cache;
  },

  /**
   * Keep a colour. Newest first, no duplicates.
   *
   * Saving one that is already kept moves it to the front rather than adding it
   * twice — the same gesture, and the operator plainly wants it to hand.
   */
  async add(color: string): Promise<{ colors: string[]; dropped: string | null }> {
    const next = [color, ...cache.filter((c) => c !== color)];
    const dropped = next.length > MAX_SAVED_COLORS ? next[next.length - 1] : null;
    cache = next.slice(0, MAX_SAVED_COLORS);
    await store.save(cache);
    return { colors: cache, dropped };
  },

  /** Forget one. Awaited, like every write of the operator's own work: a save
   *  that silently failed would read as saved until the next restart. */
  async remove(color: string): Promise<string[]> {
    cache = cache.filter((c) => c !== color);
    await store.save(cache);
    return cache;
  },
};
