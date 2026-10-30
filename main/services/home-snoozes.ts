// Home's snoozed attention items, shared by every browser.
//
// Needs attention derives its list in the browser from state Home already
// reads, so the server knows nothing about what a problem IS. It stores only the
// operator's decision about one: this key, at this severity, is handled.
//
// Shared rather than per-browser because the booth and the iPad must agree on
// what is handled -- a problem snoozed at the desk that still shouts on the
// stage tablet gets snoozed again, and again.
//
// "runtime", not "config": a snooze is an observation about this week. A
// restore of a month-old backup must not resurrect last month's decisions.
//
// A snooze lasts until the next service STARTS: pco:live reporting an item
// running after something that was not. Where Planning Center is not configured
// no service is ever announced, so a snooze there lapses after 12 hours.
//
// The first pco:live this process sees only sets a baseline. A restart in the
// middle of a service must not read as the service starting, or a restart would
// un-snooze everything.
//
// Severity is stored, never compared here: whether a mic that was a warning at
// snooze time is now critical is the widget's call (see attention/snooze.ts),
// because only the widget knows the item's current severity.

import { addBroadcastListener, broadcast } from "./broadcaster.js";
import { DataStore } from "./data-store.js";
import { plural } from "./plural.js";
import { scrub, scrubError } from "./scrub.js";
import { WriteQueue } from "./write-queue.js";
import {
  HOME_SNOOZES_CHANNEL,
  SNOOZE_KEY,
  SNOOZE_NO_PCO_MS,
  type AttentionSeverity,
  type HomeSnooze,
  type HomeSnoozesState,
} from "../types/home-snoozes.js";

interface SnoozeFile {
  snoozes: HomeSnooze[];
}

/** A body that breaks a rule; the route answers it 400. */
export class SnoozeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnoozeRefused";
  }
}

const store = new DataStore<SnoozeFile>("home-snoozes.json", { snoozes: [] }, "runtime");

// setTimeout takes a signed 32-bit number of milliseconds.
const MAX_TIMER_MS = 2 ** 31 - 1;

function isSeverity(v: unknown): v is AttentionSeverity {
  return v === "critical" || v === "warn";
}

export class HomeSnoozes {
  /** A Map, so a key off the wire is an entry and never a prototype property. */
  private snoozes = new Map<string, HomeSnooze>();
  private rev = 0;
  private loaded = false;
  private wasLive: boolean | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private writes = new WriteQueue();

  state(): HomeSnoozesState {
    return { rev: this.rev, snoozes: [...this.snoozes.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
  }

  /** Load the file and start watching pco:live. Call once, at boot. */
  async start(): Promise<void> {
    const file = await store.load();
    const now = Date.now();
    for (const s of file.snoozes ?? []) {
      if (typeof s?.key !== "string" || !SNOOZE_KEY.test(s.key) || !isSeverity(s.severity)) continue;
      if (s.expiresAt !== null && s.expiresAt <= now) continue;
      this.snoozes.set(s.key, { key: s.key, severity: s.severity, at: Number(s.at) || now, expiresAt: s.expiresAt ?? null });
    }
    this.loaded = true;
    this.armExpiry();
    addBroadcastListener((channel, payload) => {
      if (channel === "pco:live") this.observeLive(payload);
    });
  }

  /**
   * Snooze `key` at `severity`. Saves before it publishes, and throws the write's
   * failure: a snooze that looked saved and was not comes back after a restart.
   */
  async snooze(key: unknown, severity: unknown, pcoConfigured: boolean): Promise<HomeSnooze> {
    if (typeof key !== "string" || !SNOOZE_KEY.test(key)) throw new SnoozeRefused("key must look like source:subject");
    if (!isSeverity(severity)) throw new SnoozeRefused('severity must be "critical" or "warn"');
    const now = Date.now();
    const entry: HomeSnooze = { key, severity, at: now, expiresAt: pcoConfigured ? null : now + SNOOZE_NO_PCO_MS };
    await this.commit(() => new Map(this.snoozes).set(key, entry));
    console.log(`[home] snoozed ${scrub(key)} (${scrub(severity)}) until ${scrub(pcoConfigured ? "next service" : "12 hours from now")}`);
    return entry;
  }

  /** Returns whether there was a snooze to remove. */
  async unsnooze(key: string): Promise<boolean> {
    if (!this.snoozes.has(key)) return false;
    await this.commit(() => {
      const next = new Map(this.snoozes);
      next.delete(key);
      return next;
    });
    console.log(`[home] unsnoozed ${scrub(key)}`);
    return true;
  }

  private async commit(build: () => Map<string, HomeSnooze>): Promise<void> {
    return this.writes.enqueue(async () => {
      const next = build();
      try {
        await store.save({ snoozes: [...next.values()] });
      } catch (err) {
        console.error("[home] could not save snoozes, NOT recorded:", scrubError(err));
        throw err;
      }
      this.snoozes = next;
      this.publish();
    });
  }

  private publish(): void {
    this.rev += 1;
    this.armExpiry();
    broadcast(HOME_SNOOZES_CHANNEL, this.state());
  }

  /** One timer, aimed at the earliest expiry. Only 12-hour snoozes have one. */
  private armExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const times = [...this.snoozes.values()].flatMap((s) => (s.expiresAt === null ? [] : [s.expiresAt]));
    if (times.length === 0) return;
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, Math.min(...times) - Date.now()));
    this.expiry = setTimeout(() => void this.lapse(), wait);
    this.expiry.unref?.();
  }

  private async lapse(): Promise<void> {
    const now = Date.now();
    const gone = [...this.snoozes.values()].filter((s) => s.expiresAt !== null && s.expiresAt <= now);
    if (gone.length === 0) {
      this.armExpiry();
      return;
    }
    await this.drop(gone.map((s) => s.key), `cleared ${plural(gone.length, "snooze")}: lapsed after 12 hours`);
  }

  private observeLive(payload: unknown): void {
    if (!this.loaded) return;
    const mode = (payload as { mode?: unknown } | null)?.mode;
    const live = mode === "item";
    const before = this.wasLive;
    this.wasLive = live;
    if (before !== false || !live || this.snoozes.size === 0) return;
    void this.drop([...this.snoozes.keys()], `cleared ${plural(this.snoozes.size, "snooze")}: service started`);
  }

  /**
   * Remove keys from a listener or timer, which has no caller to hand a failure
   * to. The memory is updated either way (the service has started; the snoozes
   * are over) and the failed write is named on /log; the next change saves the
   * whole file again.
   */
  private async drop(keys: string[], why: string): Promise<void> {
    const next = new Map(this.snoozes);
    for (const k of keys) next.delete(k);
    try {
      await this.writes.enqueue(() => store.save({ snoozes: [...next.values()] }));
    } catch (err) {
      console.error("[home] could not save snoozes after clearing them:", scrubError(err));
    }
    this.snoozes = next;
    this.publish();
    console.log(`[home] ${scrub(why)}`);
  }
}

export const homeSnoozes = new HomeSnoozes();
