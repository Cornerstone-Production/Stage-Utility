// trends-prefs.ts -- which Smaart metric the History Trends card's Sound
// measure plots, one answer for the whole organisation.
//
// "config": somebody chose it, and a restore onto a fresh box should come back
// showing the same chart. Shared rather than per-browser because the booth and
// the tablet by the desk must read the same number off the same card; a choice
// that existed on one of them would read as the other being wrong.
//
// The History SPL section's Customize list stays per-browser and is a separate
// thing. Only Trends reads this.
//
// Served from memory: the hello burst cannot await, so start() loads the file
// once and state() answers synchronously.

import { broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";
import { asObject, checked, refuse } from "./restore-check.js";
import { scrub } from "./scrub.js";
import { WriteQueue } from "./write-queue.js";
import { METRIC_KEY, TRENDS_PREFS_CHANNEL, type TrendsPrefsState } from "../types/trends-prefs.js";

interface TrendsPrefsFile {
  soundMetric: string | null;
}

/** A body that breaks a rule; the route answers it 400. */
export class TrendsPrefsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrendsPrefsRefused";
  }
}

/** Why `value` cannot be a saved metric, or null when it can. null clears. */
function metricProblem(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !METRIC_KEY.test(value)) {
    return "soundMetric must be a metric name such as \"LAeq 2\", or null";
  }
  return null;
}

/** A restored file: held to the rule a save applies. */
const restoreCheck = checked((raw) => {
  const file = asObject(raw, "the trends settings");
  const problem = metricProblem(file.soundMetric ?? null);
  if (problem) refuse(problem);
  return { soundMetric: file.soundMetric ?? null };
});

const store = new DataStore<TrendsPrefsFile>("trends-prefs.json", { soundMetric: null }, "config", { restoreCheck });

export class TrendsPrefs {
  private soundMetric: string | null = null;
  private rev = 0;
  private writes = new WriteQueue();

  state(): TrendsPrefsState {
    return { rev: this.rev, soundMetric: this.soundMetric };
  }

  /** Load the file. Call once, at boot. */
  async start(): Promise<void> {
    const file = await store.load();
    const saved = file?.soundMetric ?? null;
    if (metricProblem(saved) === null) {
      this.soundMetric = saved;
      return;
    }
    // Left on disk where the operator (or a hand edit) put it: it is skipped,
    // not deleted, so a fix or a restore can still make it good.
    console.warn(`[history] trends-prefs.json holds a sound metric that is not a metric name (${scrub(JSON.stringify(saved))}); using the default`);
  }

  /**
   * Choose the metric, or null to clear back to the default. Saves before it
   * publishes and throws the write's failure: a choice that looked saved and was
   * not would come back as the old one after a restart. A value that is already
   * the choice writes and broadcasts nothing.
   */
  async setSoundMetric(value: unknown): Promise<TrendsPrefsState> {
    const problem = metricProblem(value);
    if (problem) throw new TrendsPrefsRefused(problem);
    const next = value as string | null;
    await this.writes.enqueue(async () => {
      if (next === this.soundMetric) return;
      await store.save({ soundMetric: next });
      this.soundMetric = next;
      this.rev++;
      broadcast(TRENDS_PREFS_CHANNEL, this.state());
      console.log(`[history] Trends sound metric ${next === null ? "cleared (default)" : `set to ${scrub(next)}`}`);
    });
    return this.state();
  }
}

export const trendsPrefs = new TrendsPrefs();
