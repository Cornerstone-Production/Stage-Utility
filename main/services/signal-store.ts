// signal-store.ts — named values the Companion module reads as variables.
//
// The app never presses a Companion button. It publishes state here; the module
// exposes each entry as `$(stage:signal_<name>)` and a Companion Trigger decides
// what to do about it. That keeps the Dante action entirely inside Companion,
// which is the boundary we want for a network that punishes mistakes.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a failure never clears a value. An
// unrelated scheduling mistake must not take a live audio route away, so `fail`
// records why beside the value and leaves the value standing. The only thing that
// changes a value is a successful evaluation.
//
// Persisted because the routing has to survive a restart, and broadcast on every
// change so a module already connected updates without polling.

import type { SignalState } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<Record<string, SignalState>>("signals.json", {}, "runtime");

/** Kept in memory so reads are synchronous for the SSE hello burst. */
let cache: Record<string, SignalState> | null = null;

async function load(): Promise<Record<string, SignalState>> {
  if (!cache) cache = await store.load();
  return cache;
}

function publish(all: Record<string, SignalState>): void {
  cache = all;
  broadcast("companion:signals", all);
}

export const signalStore = {
  /** Load once at startup so `all()` is populated before the first client connects. */
  async init(): Promise<void> {
    await load();
  },

  /** Every signal, for the SSE hello burst. Empty until init() has run. */
  all(): Record<string, SignalState> {
    return cache ?? {};
  },

  /** A successful evaluation: set the value and clear any previous error. */
  async set(name: string, value: string, meta: { ruleId?: string | null } = {}): Promise<void> {
    const key = name.trim();
    if (!key) return;
    const next = await store.update((cur) => ({
      ...cur,
      [key]: { value, at: new Date().toISOString(), ruleId: meta.ruleId ?? null, error: null },
    }));
    publish(next);
  },

  /**
   * A failed evaluation: record why, and LEAVE THE VALUE ALONE.
   *
   * A signal that has never resolved gets an empty value so the module can show the
   * error without inventing a route.
   */
  async fail(name: string, reason: string, meta: { ruleId?: string | null } = {}): Promise<void> {
    const key = name.trim();
    if (!key) return;
    const next = await store.update((cur) => {
      const prev = cur[key];
      return {
        ...cur,
        [key]: {
          value: prev?.value ?? "",
          at: prev?.at ?? new Date().toISOString(),
          ruleId: meta.ruleId ?? prev?.ruleId ?? null,
          error: reason,
        },
      };
    });
    publish(next);
  },
};
