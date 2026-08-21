// stream-start-store.ts — when we first saw each platform go live.
//
// Only needed because a platform may report that it IS streaming without saying
// since when. Resi's encoder status is the case in hand: it carries a state, not
// a start time. The elapsed clock has to come from somewhere, and the only
// honest alternative to a real start time is the first moment this app observed
// the stream.
//
// Persisted, because the failure it prevents is specific and happens at the
// worst time: the server restarts mid-service — an update, a crash, a power
// blip — and an in-memory start would reset to zero. The number on the wall
// would then say the stream began seconds ago when it has been running for
// forty minutes.
//
// RUNTIME, not config. It is an observation about a stream that happened, not
// the operator's work, and restoring last month's backup must not tell today's
// service it went live in July.

import { DataStore } from "./data-store.js";

/** Platform id -> ISO moment we first saw it live. */
type Starts = Record<string, string>;

const store = new DataStore<Starts>("stream-starts.json", {}, "runtime");

let cache: Starts = {};
let loaded = false;

export const streamStartStore = {
  /** Read from disk once, at startup. Safe to call more than once. */
  async init(): Promise<void> {
    if (loaded) return;
    cache = await store.load();
    loaded = true;
  },

  /**
   * The moment this platform's current stream started, recording now as the
   * start if this is the first sighting.
   *
   * Reads through the cache rather than awaiting a load, because the caller is a
   * poll tick and must not block on disk. Before init() has run this simply
   * starts a fresh clock, which is correct: nothing has been observed yet.
   */
  observe(platform: string): string {
    const existing = cache[platform];
    if (existing) return existing;
    const now = new Date().toISOString();
    cache = { ...cache, [platform]: now };
    void store.save(cache).catch((err) => {
      // Reported rather than swallowed, but not thrown: losing the persisted
      // start costs an accurate clock after a restart, and taking the poll down
      // with it would cost the live indicator entirely.
      console.error("[stream-starts] could not persist the observed start:", err);
    });
    return now;
  },

  /** A real start time from the platform. Stored so a restart keeps agreeing
   *  with it even if the platform stops reporting it. */
  remember(platform: string, startedAt: string): void {
    if (cache[platform] === startedAt) return;
    cache = { ...cache, [platform]: startedAt };
    void store.save(cache).catch((err) => {
      console.error("[stream-starts] could not persist the reported start:", err);
    });
  },

  /** The stream ended. Forget it, so the next one times from its own start. */
  clear(platform: string): void {
    if (!(platform in cache)) return;
    const next = { ...cache };
    delete next[platform];
    cache = next;
    void store.save(cache).catch((err) => {
      console.error("[stream-starts] could not clear the observed start:", err);
    });
  },

  /** For tests. */
  _reset(): void {
    cache = {};
    loaded = false;
  },
};
