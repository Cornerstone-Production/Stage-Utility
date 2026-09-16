// cue-live.ts — the `cues` channel: state as it changes, for an integration.
//
// `GET /api/cues/states` is a POLL, and a poll is what a Home Assistant switch
// looks like when it lags: somebody turns a light off at the wall and the app
// says it is on until the next scan. This pushes instead.
//
// SUBSCRIBER-GATED, and this one is gated harder than the rest of the app. Most
// producers here run their timer regardless and skip the WORK when nothing is
// watching (`channelHasSubscribers` at the top of a tick). That is right for a
// producer whose timer is already running for its own reasons; it is wrong
// here, because there is nothing else this timer is for — an install with no
// integration would ask Companion for every bound variable every five seconds,
// for the rest of the week, for nobody. So there is NO TIMER AT ALL until
// somebody subscribes, and it is cleared when the last one leaves. The
// broadcaster tells us when that happens; see addSubscriptionListener.
//
// THE POLL IS THE CACHE REFRESH. It drops cue-states' five second cache and
// reads, rather than reading around it, so `GET /api/cues/states` and the rules
// page share the same round of Companion reads while this is running instead of
// doubling them.
//
// ONLY CHANGES GO OUT. A projector that has been on since Thursday is not an
// event; sending its state every five seconds is a channel an integration has
// to de-duplicate itself, and a log nobody can read.
//
// TWO CHANNELS, ONE ROUND OF READS. `cues` is the integration's and carries
// what the manifest carries — hidden pairs are not on it. `cues:all` is this
// app's own cue buttons and carries every pair, each hidden one saying so. A
// subscriber on either starts the poll; both are fed from the same read.

import {
  addSubscriptionListener,
  broadcast,
  channelHasSubscribers,
  channelSubscriberCount,
} from "./broadcaster.js";
import { bumpManifestVersion } from "./cue-manifest.js";
import { addSettleListener, cueStates, type CueStateName } from "./cue-states.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";

/** The SSE channel. */
export const CUES_CHANNEL = "cues";

/**
 * Every pair, hidden from Home Assistant or not, for the app's own cue buttons.
 * `cues` stays exactly what the integration has always read.
 */
export const CUES_ALL_CHANNEL = "cues:all";

/**
 * How often bound variables are read while somebody is subscribed.
 *
 * The same five seconds cue-states caches for, deliberately: a shorter poll
 * would read the cache back and push nothing, and a longer one would leave the
 * cache stale between reads.
 */
export const CUES_POLL_MS = 5000;

/** One bound pair's state, as the channel and the states route both carry it. */
interface LiveRow {
  state: CueStateName;
  reason?: string;
  settling?: true;
  commanded?: "on" | "off";
  /** The operator hid this pair from Home Assistant. See the tick. */
  hiddenFromHome?: true;
}

/**
 * What goes out on either channel. `hiddenFromHome` is said only on `cues:all`;
 * on `cues` a hidden pair is not an event at all.
 */
export type CuesEvent =
  | ({ type: "state"; id: string; hiddenFromHome?: true } & LiveRow)
  | { type: "manifest"; version: number };

/**
 * The seams. Tests replace the timer with a captured callback — which is what
 * lets "no subscribers means no reads" be asserted as a stub that was never
 * called, rather than as a wait — and the read with a stub.
 */
export const cueLiveDeps: {
  subscribers: () => number;
  watched: () => boolean;
  /** Drop the cached answer and read Companion. The poll IS the refresh. */
  read: () => Promise<{ states: ReadonlyMap<string, LiveRow> }>;
  setInterval: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (t: NodeJS.Timeout) => void;
  emit: (event: CuesEvent) => void;
  emitAll: (event: CuesEvent) => void;
} = {
  // BOTH channels, in both: the reads are the same round either way, and a
  // console on a panel with no Home Assistant anywhere is an install where
  // counting only `cues` means the poll never starts and no button ever moves.
  subscribers: () => channelSubscriberCount(CUES_CHANNEL) + channelSubscriberCount(CUES_ALL_CHANNEL),
  watched: () => channelHasSubscribers(CUES_CHANNEL) || channelHasSubscribers(CUES_ALL_CHANNEL),
  read: async () => {
    cueStates.invalidate();
    return cueStates.read();
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    // A push channel must never be what keeps the process alive.
    t.unref();
    return t;
  },
  clearInterval: (t) => clearInterval(t),
  emit: (event) => broadcast(CUES_CHANNEL, event),
  emitAll: (event) => broadcast(CUES_ALL_CHANNEL, event),
};

class CueLive {
  private timer: NodeJS.Timeout | null = null;
  /** The last state pushed for each pair on `cues`, so only CHANGES go out. */
  private last = new Map<string, string>();
  /**
   * The same for `cues:all`, and a SEPARATE map because the two channels are
   * sent different sets. Shared, a pair that was hidden when a panel first saw
   * it would never be pushed to Home Assistant on unhiding: the key would
   * already be set by a push nobody on `cues` was sent.
   */
  private lastAll = new Map<string, string>();
  /** One read at a time: a slow Companion must not stack ticks. */
  private reading = false;

  /**
   * Start or stop polling, from the subscriber set as it is right now.
   *
   * Idempotent in both directions — it is called on every connect, subscribe
   * and disconnect, and most of those change nothing.
   */
  subscriptionsChanged(): void {
    if (cueLiveDeps.watched()) this.start();
    else this.stop();
  }

  /**
   * A settling pair's variable has caught up with the press that moved it.
   *
   * Read and pushed AT ONCE rather than at the next five-second tick: that
   * tick is what made Home Assistant flip a switch back to a value from before
   * the press, which invites another tap. Nothing is read when nobody is
   * subscribed — cue-states has already refreshed its own answer for the
   * caller, and this channel has nobody to tell.
   */
  settled(): void {
    if (!cueLiveDeps.watched()) return;
    void this.tick();
  }

  /** The rules changed: the manifest has a new version, and anything watching
   *  should re-read it. */
  rulesChanged(): void {
    const event: CuesEvent = { type: "manifest", version: bumpManifestVersion() };
    cueLiveDeps.emit(event);
    cueLiveDeps.emitAll(event);
    // What a pair is may have changed entirely — a binding edited, a pair
    // deleted — so the last-pushed states are no longer a comparison anything
    // can be trusted against.
    this.last.clear();
    this.lastAll.clear();
  }

  private start(): void {
    if (this.timer) return;
    console.log(
      `[cues] live channel: polling every ${scrub(CUES_POLL_MS / 1000)} s ` +
        `for ${scrub(cueLiveDeps.subscribers())} subscriber(s)`,
    );
    this.timer = cueLiveDeps.setInterval(() => {
      void this.tick();
    }, CUES_POLL_MS);
    // The first read goes out at once rather than five seconds later: a client
    // that has just subscribed is looking at nothing until it does.
    void this.tick();
  }

  private stop(): void {
    if (!this.timer) return;
    cueLiveDeps.clearInterval(this.timer);
    this.timer = null;
    this.last.clear();
    this.lastAll.clear();
    console.log(`[cues] live channel: polling stopped`);
  }

  /** One round of reads, with only what changed pushed. */
  private async tick(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const answer = await cueLiveDeps.read();
      // HIDDEN PAIRS ARE NOT ON `cues`. The manifest omits a hidden pair
      // entirely — `/api/cues/manifest` says it does not exist — so pushing
      // state for it is this server telling an integration about an entity it
      // has just been told not to create. `/api/cues/states` keeps the row,
      // deliberately: the app's own rules page reads that route for the state
      // pill on every pair, hidden or not. See CueStateRow.hiddenFromHome.
      //
      // They ARE on `cues:all`, whose audience is this app's own cue buttons —
      // a panel is the operator's console, not Home Assistant, and a button
      // bound to a hidden pair must still show what its device is doing.
      //
      // Filtered ONCE, here, so each channel's prune compares against what that
      // channel was actually sent rather than against the whole answer.
      const all = [...answer.states];
      const shown = all.filter(([, row]) => !row.hiddenFromHome);
      this.push(shown, this.last, cueLiveDeps.emit, false);
      this.push(all, this.lastAll, cueLiveDeps.emitAll, true);
    } catch (err) {
      // NOT swallowed: cueStates.read is documented as never throwing, so this
      // is the case where that contract broke. Logged and the poll carries on,
      // because the alternative — rethrowing out of a timer callback — takes
      // the process down for one unreadable variable. There is no caller to
      // return it to; the log is the caller.
      console.error(`[cues] live channel read failed: ${scrub(errorMessage(err))}`);
    } finally {
      this.reading = false;
    }
  }

  /**
   * Push what changed since the last round on one channel.
   *
   * `sayHidden` is what separates the two: on `cues:all` a hidden pair carries
   * `hiddenFromHome: true` so a cue button can draw it as what it is, and on
   * `cues` a hidden pair never reaches here at all.
   */
  private push(
    rows: [string, LiveRow][],
    last: Map<string, string>,
    emit: (event: CuesEvent) => void,
    sayHidden: boolean,
  ): void {
    for (const [id, row] of rows) {
      // The REASON is part of the comparison: a pair that goes from
      // unreachable to "value matches neither" is still unknown, and an
      // integration showing why has been told the wrong why until something
      // else changes.
      //
      // And so is SETTLING, in both directions. Entering the window is worth
      // an event — it is what tells an integration to show the commanded
      // state rather than a reading it has been told is stale — and so is
      // leaving it, or a subscriber told a pair was settling would believe it
      // for the rest of the day.
      //
      // The separator was a literal NUL byte in this file, which is legal and
      // invisible. A space does the same job here: `state` and `commanded`
      // are both closed sets, so no two rows can spell one key between them.
      const key = `${row.state} ${row.reason ?? ""} ${row.commanded ?? ""}`;
      if (last.get(id) === key) continue;
      last.set(id, key);
      const event: CuesEvent = { type: "state", id, state: row.state };
      if (row.reason) event.reason = row.reason;
      if (row.settling) {
        event.settling = true;
        event.commanded = row.commanded;
      }
      if (sayHidden && row.hiddenFromHome) event.hiddenFromHome = true;
      emit(event);
    }
    // A pair that has gone away — deleted, unbound, or hidden — stops being
    // compared against, or re-adding it later would push nothing until its
    // state changed.
    //
    // A SET of what was pushed, and `has` rather than `in`. This was
    // `id in answer.states` over a plain object, which walks the PROTOTYPE
    // CHAIN: of every key on Object.prototype exactly one is a legal cue name,
    // and `constructor_on`/`constructor_off` is a pair the engine accepts
    // today. `"constructor" in {}` is true, so that base was never pruned —
    // delete the pair, re-create it, and `last` still held the stale key, so
    // no `state` event went out and the entity read unknown until the device
    // physically changed.
    const pushed = new Set(rows.map(([id]) => id));
    for (const id of last.keys()) if (!pushed.has(id)) last.delete(id);
  }
}

export const cueLive = new CueLive();

// Registered at import, not at server start: the engine imports this module for
// `rulesChanged`, so it is loaded well before anything can subscribe, and a
// start() that depended on boot ordering is a channel that silently never runs.
addSubscriptionListener(() => cueLive.subscriptionsChanged());
// Same reason, and this direction only: cue-states must not import this module
// back, so it announces a value that landed and this decides what to do about it.
addSettleListener(() => cueLive.settled());
