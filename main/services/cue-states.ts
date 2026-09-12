// cue-states.ts — what a bound cue pair's device is ACTUALLY doing.
//
// Companion answers a press the moment it hands it to a control and never says
// what happened at the other end, so a generated Home Assistant switch can only
// report what it asked for. `optimistic: true` is the honest spelling of that,
// and it is also why a projector somebody turned off at the wall still reads on
// in the house.
//
// The way out is a Companion CUSTOM VARIABLE. The operator's own ON and OFF
// buttons set `projectors_state` to `on` and `off`; a cue pair says which
// variable is its own (see cue-pairs.ts); this reads it. Stage Utility never
// writes one — the state has to come from the buttons that did the work, or it
// is the same optimism one system further along.
//
// ON DEMAND, WITH NO STANDING TIMER. Integrations here are change-driven and
// subscriber-gated, and there is nothing to subscribe to: Companion does not
// push a custom variable. So the variables are read when somebody ASKS —
// `GET /api/cues/states` — and the whole answer is cached for five seconds. A
// Home Assistant sensor polling every ten seconds costs one round of reads per
// poll; a page with the rules list open costs the same round shared with it; and
// an install nobody is polling costs nothing at all. A background timer would
// poll Companion every ten seconds for the rest of the week for nobody.
//
// THE ONE EXCEPTION is a press. Companion reads a plug on its own interval, so
// for a second or two after a press the variable still holds the old value.
// `noteCommand` remembers what was commanded (SETTLE_MS) and re-reads that ONE
// variable every second until it agrees — a bounded, unref'd timer that cannot
// outlive the window, and nothing at all on an install nobody presses.
//
// NOT EVERY BINDING IS A COMPANION VARIABLE. A pair bound to `app:<source>`
// (app-state-sources.ts) is answered from inside this process — REAPER's
// transport poll, for a cue that starts a recording — in the same shape, through
// the same seam, with the same cache and the same settle re-read. Nothing below
// the seam distinguishes the two.
//
// Reads run in PARALLEL and one variable is read ONCE however many pairs bind
// it: the answer waits for the slowest read, and eight sequential three-second
// timeouts on an unplugged Companion is a request Home Assistant has long since
// given up on.

import { readAppState } from "./app-state-reads.js";
import { isAppStateRef } from "./app-state-sources.js";
import { boundCuePairs, STATE_ANY_OTHER } from "./cue-pairs.js";
import { errorMessage } from "./errors.js";
import { companionApi, type VariableResult } from "./companion-api.js";
import { scrub } from "./scrub.js";
import type { Rule } from "../types/automation.js";

/**
 * How long one answer is served for.
 *
 * Under Home Assistant's ten-second poll on purpose, so a poll never reads the
 * previous poll's answer — a switch that lagged a press by a whole scan would be
 * read as the press not having worked, and pressed again.
 */
export const CUE_STATES_TTL_MS = 5000;

/**
 * How long a real press outranks the variable it is supposed to move.
 *
 * COMPANION LAGS. It polls a smart plug on its own interval — one to five
 * seconds is normal — so for a moment after a press the variable still holds
 * the value from before it. A caller flipping a switch in Apple Home twice
 * quickly hit that gap: the second call read the pre-press value, decided the
 * device was already where it was being asked to go, pressed nothing, and the
 * light stayed on with Home showing it off.
 *
 * So a press is REMEMBERED, and inside this window the command is what a repeat
 * is compared against rather than the reading (see the engine's callByName).
 * Eight seconds covers the slowest Companion poll observed with room over it,
 * and is short enough that a device somebody turns off at the wall a moment
 * later is reported honestly almost at once.
 */
export const SETTLE_MS = 8000;

/**
 * How often the commanded variable is re-read while it settles.
 *
 * Only the one variable, only inside the window, and it stops the moment the
 * value equals what was commanded — so a plug that catches up in two seconds
 * costs two reads and not eight. This is what makes the live channel push the
 * new state within a second or so of it landing, rather than at the next
 * five-second tick.
 */
export const SETTLE_POLL_MS = 1000;

/** on, off, or nobody can say. */
export type CueStateName = "on" | "off" | "unknown";

/** What a real press asked a pair's device to do. */
export interface CueCommand {
  /** The pair's base — the key everything else in here is keyed by. */
  base: string;
  want: "on" | "off";
  /** The pair's bound variable, which is what gets re-read while it settles. */
  variable: string;
  /** The value that variable will hold once the device has caught up. */
  wantValue: string;
}

/** One pair's state, keyed in the answer by the pair's base. */
export interface CueStateRow {
  /** The `_on` half's cue name. */
  on: string;
  /** The `_off` half's cue name. */
  off: string;
  /**
   * What this was read from: a Companion variable (custom, or
   * `<label>:<name>`), or an `app:<source>` this app answers itself.
   */
  variable: string;
  /** What the variable held, or null when it could not be read at all. */
  value: string | null;
  state: CueStateName;
  /** Why the state is unknown. Absent for on and off. */
  reason?: string;
  /**
   * A real press was dispatched for this pair inside the last SETTLE_MS, and
   * `value` may still be from before it. Absent otherwise, never false.
   */
  settling?: true;
  /** What that press asked for. Present exactly when `settling` is. */
  commanded?: "on" | "off";
}

export interface CueStatesAnswer {
  /** Every bound pair resolved to on or off. False when any is unknown. */
  ok: boolean;
  /** When these values were read, ISO. Home Assistant reads it as the sensor's state. */
  checkedAt: string;
  /** Keyed by the pair's base — the Home Assistant switch id. */
  states: Record<string, CueStateRow>;
}

/**
 * The seams. Tests replace all three: an injected clock is what makes the cache
 * assertable without waiting five real seconds, and a stubbed read is what lets
 * every failure be covered without a Companion.
 *
 * `rules` reaches the engine through a DYNAMIC import for the same reason
 * companion-api's `getTarget` does — the engine imports the services it drives,
 * and a static import here would close a cycle through it.
 */
export const cueStatesDeps: {
  now: () => number;
  rules: () => Promise<readonly Rule[]>;
  read: (variable: string) => Promise<VariableResult>;
  /** The settle re-read's timer. Injected so the 1 s poll is assertable. */
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (t: NodeJS.Timeout) => void;
} = {
  now: () => Date.now(),
  rules: async () => (await import("./automation-engine.js")).automationEngine.listRules(),
  // TWO NAMESPACES, one seam. An `app:` ref is answered from this process (the
  // REAPER transport poll, say) and everything else is a Companion variable —
  // both in the same VariableResult shape, so nothing below this line, including
  // the settle re-read, knows which kind it is reading.
  read: async (variable) =>
    isAppStateRef(variable) ? readAppState(variable) : companionApi.readVariable(variable),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // A re-read that lasts eight seconds must never be what keeps the process
    // alive, and it must never delay a shutdown.
    t.unref();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t),
};

/**
 * Told when a settling variable's value CHANGES, so the live channel can push it
 * the moment it lands instead of at its next five-second tick.
 *
 * A listener rather than a dep, because the listener is cue-live and cue-live
 * already imports this module — a dep would have to be assigned from over
 * there, and a test that replaced the deps object would silently unregister it.
 */
const settleListeners = new Set<(variable: string) => void>();

export function addSettleListener(fn: (variable: string) => void): void {
  settleListeners.add(fn);
}

class CueStates {
  private cached: { at: number; answer: CueStatesAnswer } | null = null;
  /** In-flight read, so two pollers arriving together read Companion once. */
  private inFlight: Promise<CueStatesAnswer> | null = null;
  /**
   * The last reason logged for each pair, so an unreachable Companion is one
   * line rather than one every ten seconds for the rest of the day.
   *
   * Keyed by the pair's BASE rather than by the variable, because one of the
   * reasons — a value matching neither of the pair's own on/off values — is a
   * property of the pair and not of the variable. Two pairs bound to the same
   * unreachable variable therefore say so once each, which is two lines, once.
   */
  private lastReason = new Map<string, string>();
  /** The last real press per pair base. Only the last one matters. */
  private commands = new Map<string, { want: "on" | "off"; at: number }>();
  /**
   * The settle re-read in progress per VARIABLE, not per pair: two pairs bound
   * to one variable are one thing to re-read, and a second command on the same
   * variable restarts the one loop rather than running two.
   */
  private settling = new Map<
    string,
    { timer: NodeJS.Timeout | null; startedAt: number; wantValue: string; last: string | null }
  >();

  /**
   * Every bound pair's state, read now or served from the last five seconds.
   *
   * Never throws: every failure is a pair reading `unknown` with the reason on
   * it, because a 500 here would take out a Home Assistant sensor covering
   * several pairs for one unplugged Companion.
   */
  async read(): Promise<CueStatesAnswer> {
    return this.withSettling(await this.readCached());
  }

  private async readCached(): Promise<CueStatesAnswer> {
    const cached = this.cached;
    if (cached && cueStatesDeps.now() - cached.at < CUE_STATES_TTL_MS) return cached.answer;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.readOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Forget the cached answer, so the next call reads Companion. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * A real press was dispatched for this pair. Called ONLY for a press that
   * reached a device — not a simulated one, not a skipped one, not a failed one,
   * because a window opened by any of those would have the app overriding a
   * truthful reading with a command nothing carried out.
   *
   * Drops the cached answer as well: what it holds is from before the press.
   */
  noteCommand(command: CueCommand): void {
    // Before the invalidate: what the variable last read is what the settle
    // re-read compares against to notice the device moving.
    const last = this.cached?.answer.states[command.base]?.value ?? null;
    this.commands.set(command.base, { want: command.want, at: cueStatesDeps.now() });
    this.invalidate();
    this.startSettling(command, last);
  }

  /**
   * The press this pair is still settling from, or null when the window has
   * lapsed or there was none.
   *
   * The engine compares a repeat against THIS rather than against the variable
   * while it is non-null. See SETTLE_MS.
   */
  commandedWithin(base: string, now: number): { want: "on" | "off"; at: number } | null {
    const command = this.commands.get(base);
    if (!command) return null;
    if (now - command.at >= SETTLE_MS) {
      this.commands.delete(base);
      return null;
    }
    return command;
  }

  /** Exposed for tests: forget every command and cancel every settle re-read. */
  __resetSettle(): void {
    this.commands.clear();
    for (const entry of this.settling.values()) {
      if (entry.timer) cueStatesDeps.clearTimeout(entry.timer);
    }
    this.settling.clear();
  }

  /**
   * The commanded state on every row that is still inside its window.
   *
   * Applied to the answer on the way OUT rather than baked into the cache: the
   * cache is served for five seconds and the window is eight, so a row that had
   * `settling` written into it would go on claiming it for up to five seconds
   * after the window closed.
   */
  private withSettling(answer: CueStatesAnswer): CueStatesAnswer {
    const now = cueStatesDeps.now();
    if (![...this.commands.keys()].some((base) => this.commandedWithin(base, now))) return answer;
    const states: Record<string, CueStateRow> = {};
    for (const [base, row] of Object.entries(answer.states)) {
      const command = this.commandedWithin(base, now);
      states[base] = command ? { ...row, settling: true, commanded: command.want } : row;
    }
    return { ...answer, states };
  }

  /**
   * Re-read the commanded variable every second until it agrees, or the window
   * closes.
   *
   * Runs whether or not anything is subscribed to the live channel: the caller
   * of the cue is the one who needs its next read to be truthful, and it is
   * capped by the window either way — no timer outlives it.
   */
  private startSettling(command: CueCommand, last: string | null): void {
    const running = this.settling.get(command.variable);
    if (running?.timer) cueStatesDeps.clearTimeout(running.timer);
    this.settling.set(command.variable, {
      timer: null,
      startedAt: cueStatesDeps.now(),
      wantValue: command.wantValue,
      // A restart keeps what the previous loop last saw, so a value that
      // changed under the old command is not announced twice.
      last: running?.last ?? last,
    });
    this.scheduleSettleRead(command.variable);
  }

  private scheduleSettleRead(variable: string): void {
    const entry = this.settling.get(variable);
    if (!entry) return;
    entry.timer = cueStatesDeps.setTimeout(() => {
      void this.settleRead(variable);
    }, SETTLE_POLL_MS);
  }

  /**
   * One re-read of a settling variable.
   *
   * Never throws — it is a timer callback, and there is nobody to return a
   * failure to. A read that fails is treated as "not there yet": the loop
   * carries on to the end of the window and says it did not settle, which is
   * the line an operator needs. cue-states' own per-variable reason line
   * already covers WHY it could not be read.
   */
  private async settleRead(variable: string): Promise<void> {
    const entry = this.settling.get(variable);
    if (!entry) return;
    entry.timer = null;
    const elapsed = cueStatesDeps.now() - entry.startedAt;
    let result: VariableResult;
    try {
      result = await cueStatesDeps.read(variable);
    } catch (err) {
      result = { error: errorMessage(err) };
    }
    // Reset, or restarted under a new command, while that read was in flight.
    if (this.settling.get(variable) !== entry) return;

    if ("value" in result) {
      if (result.value !== entry.last) {
        entry.last = result.value;
        // The cached answer was read before this value landed.
        this.invalidate();
        for (const listener of settleListeners) listener(variable);
      }
      if (result.value === entry.wantValue) {
        this.settling.delete(variable);
        console.log(
          `[cues] state of ${scrub(variable)} settled to ${scrub(result.value)} ` +
            `after ${scrub(Math.round(elapsed / 1000))} s`,
        );
        return;
      }
    }

    if (cueStatesDeps.now() - entry.startedAt >= SETTLE_MS) {
      this.settling.delete(variable);
      console.warn(
        `[cues] state of ${scrub(variable)} did not settle within ${scrub(SETTLE_MS / 1000)} s`,
      );
      return;
    }
    this.scheduleSettleRead(variable);
  }

  private async readOnce(): Promise<CueStatesAnswer> {
    const pairs = boundCuePairs(await cueStatesDeps.rules());
    const variables = [...new Set(pairs.map((p) => p.binding!.variable))];
    // allSettled, not all. `read` is documented as never throwing and every
    // implementation of it means to be, but one rejection under Promise.all
    // rejects the whole batch and takes `read()` — and with it the route, and
    // with it every OTHER pair's state — down with it. That is the failure this
    // module exists to avoid, one level up: a rejected read is that variable's
    // `{ error }` and nobody else's problem.
    const settled = await Promise.allSettled(variables.map((v) => cueStatesDeps.read(v)));
    const read = new Map<string, VariableResult>(
      variables.map((v, i) => {
        const result = settled[i]!;
        return [v, result.status === "fulfilled" ? result.value : { error: errorMessage(result.reason) }];
      }),
    );

    // A MAP, not a plain record. The key is the pair's base, which comes from a
    // cue name in the rules file — and `record["__proto__"] = row` does not add
    // a property, it replaces the object's prototype, so the pair vanishes from
    // the answer and every object in the process gains its fields. A Map holds
    // any string, and Object.fromEntries below defines an own property for it.
    const states = new Map<string, CueStateRow>();
    for (const pair of pairs) {
      const binding = pair.binding!;
      const result = read.get(binding.variable) ?? { error: "not read" };
      const row: CueStateRow = {
        on: pair.onName,
        off: pair.offName,
        variable: binding.variable,
        value: "value" in result ? result.value : null,
        state: "unknown",
      };
      if ("error" in result) {
        row.reason = result.error;
      } else if (result.value === binding.onValue) {
        row.state = "on";
      } else if (binding.offValue === STATE_ANY_OTHER || result.value === binding.offValue) {
        // `*` is "anything that is not the on value", so a status variable with
        // seven off values needs one row rather than six unknowns. The variable
        // was READ — an empty string included — so this is off and not unknown;
        // a variable that could not be read at all is the `error` branch above.
        row.state = "off";
      } else {
        row.reason =
          `value "${result.value}" matches neither ` +
          `"${binding.onValue}" nor "${binding.offValue}"`;
      }
      this.note(pair.base, binding.variable, row.reason ?? null);
      states.set(pair.base, row);
    }

    const answer: CueStatesAnswer = {
      ok: [...states.values()].every((s) => s.state !== "unknown"),
      checkedAt: new Date(cueStatesDeps.now()).toISOString(),
      states: Object.fromEntries(states),
    };
    this.cached = { at: cueStatesDeps.now(), answer };
    return answer;
  }

  /**
   * Log a pair's failure, and only when it CHANGED.
   *
   * The successes are not logged — a readable variable every ten seconds is the
   * whole log gone by lunchtime — but the recovery is, once, because "it started
   * working again at 9:14" is the line that closes the question an operator
   * opened the log with.
   */
  private note(base: string, variable: string, reason: string | null): void {
    const previous = this.lastReason.get(base) ?? "";
    const current = reason ?? "";
    if (current === previous) return;
    this.lastReason.set(base, current);
    // The VARIABLE is named first: it is what the operator opens Companion to
    // look at. The base says which cue pair asked, for the case where two pairs
    // read one variable.
    if (current) {
      console.warn(`[cues] state of ${scrub(variable)} (${scrub(base)}) unreadable: ${scrub(current)}`);
    } else {
      console.log(`[cues] state of ${scrub(variable)} (${scrub(base)}) is readable again`);
    }
  }
}

export const cueStates = new CueStates();
