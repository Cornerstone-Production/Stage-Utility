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
// ON DEMAND, WITH NO TIMER. Integrations here are change-driven and
// subscriber-gated, and there is nothing to subscribe to: Companion does not
// push a custom variable. So the variables are read when somebody ASKS —
// `GET /api/cues/states` — and the whole answer is cached for five seconds. A
// Home Assistant sensor polling every ten seconds costs one round of reads per
// poll; a page with the rules list open costs the same round shared with it; and
// an install nobody is polling costs nothing at all. A background timer would
// poll Companion every ten seconds for the rest of the week for nobody.
//
// Reads run in PARALLEL and one variable is read ONCE however many pairs bind
// it: the answer waits for the slowest read, and eight sequential three-second
// timeouts on an unplugged Companion is a request Home Assistant has long since
// given up on.

import { boundCuePairs } from "./cue-pairs.js";
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

/** on, off, or nobody can say. */
export type CueStateName = "on" | "off" | "unknown";

/** One pair's state, keyed in the answer by the pair's base. */
export interface CueStateRow {
  /** The `_on` half's cue name. */
  on: string;
  /** The `_off` half's cue name. */
  off: string;
  /** The Companion custom variable this was read from. */
  variable: string;
  /** What the variable held, or null when it could not be read at all. */
  value: string | null;
  state: CueStateName;
  /** Why the state is unknown. Absent for on and off. */
  reason?: string;
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
} = {
  now: () => Date.now(),
  rules: async () => (await import("./automation-engine.js")).automationEngine.listRules(),
  read: (variable) => companionApi.readCustomVariable(variable),
};

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

  /**
   * Every bound pair's state, read now or served from the last five seconds.
   *
   * Never throws: every failure is a pair reading `unknown` with the reason on
   * it, because a 500 here would take out a Home Assistant sensor covering
   * several pairs for one unplugged Companion.
   */
  async read(): Promise<CueStatesAnswer> {
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
      } else if (result.value === binding.offValue) {
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
