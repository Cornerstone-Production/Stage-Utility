// companion-state-learn.ts — finding a state source for a device the table
// does not know, by watching what moves when the pair is pressed.
//
// PURE. Every function here is a decision over values; the probing, the reads
// and the rule writes live in companion-state-probe.ts, which is the only
// impure half. The settings page imports the hint sentence and the params
// helpers from here, so nothing in this file may reach a socket or a file.
//
// WHICH CONNECTIONS have no table row is decided one file over, in
// companion-state-source.ts's learnableConnections — it is a fact about the
// table, it is read while the export is walked, and declaring it here would
// close a cycle (companion-export imports it, and this imports
// companion-export for the variable-reference grammar).
//
// WHY THIS EXISTS. companion-state-source.ts is a table of verified module
// variables, and every row of it was read off a live Companion or out of a
// module's source. That is the right way round — a guessed variable name is a
// switch that reads unknown forever, and a guessed ON value is one that reads
// unknown at exactly the moment the device is doing the thing. But a table is
// a table: a module added to Companion next month has no row, and the honest
// answer to "can the table update itself?" is that it cannot. Companion's
// export carries no variable DEFINITIONS at all, and its HTTP API has no
// endpoint that lists a connection's variables — only
// `/api/variable/<label>/<name>/value`, which answers 200 or 404 for a name you
// already have to know.
//
// So: PROBE, then WATCH. A name that answers 200 exists; a name that answers
// 404 does not. That turns "which variables does this connection publish?" into
// a list of guesses that can be checked, and the guessing is safe because a
// wrong guess is discarded rather than bound. Then the two VALUES — which are
// the other half of a binding and the half that fails silently — are not
// guessed at all. They are read off the device: the pair is pressed ON, the
// candidate that moved is noted with what it moved to, the pair is pressed OFF,
// and a candidate that moved BOTH times and took exactly two values is the
// variable that answers this pair. Nothing is bound from one press, because one
// press cannot tell a power variable from a clock.
//
// WHAT IT NEVER DOES. It never presses anything — every observation rides a
// press an operator or a caller made. It never overrides a binding, inferred or
// typed. And it gives up: three presses with nothing learned and it stops and
// says so on the log, because a pair quietly probing 19 names an hour forever is
// worse than a pair an operator binds by hand in ten seconds.

import { isCompanionVariableRef } from "./companion-export.js";
import { STATE_SOURCES } from "./companion-state-source.js";

/**
 * The variable names worth asking a connection about.
 *
 * Two sources, and the comment on each group says which:
 *
 *  1. EVERY NAME THE VERIFIED TABLE KNOWS. A module the table does not cover
 *     may still publish a name a covered module uses — the two kasa modules
 *     already share `power_state` — so the table's own names are the best
 *     evidence there is about what a Companion module calls this.
 *  2. THE COMMON SHAPES. The spellings a module author reaches for, in the
 *     three families that matter to an ON/OFF pair: power, recording and
 *     streaming, plus the generic `status`/`state`/`active` family and the two
 *     an audio or comms module uses (`mute`, `connected`).
 *
 * A NAME COSTS ONE GET, once an hour, per learning pair. There is no reason to
 * be clever about the order and every reason to keep the list short: this is
 * dialled at a Companion that is also running a service.
 *
 * Deliberately NOT a list of every plausible English word. A name that is not
 * here is a pair an operator binds by hand, which is the same work they do
 * today; a name that is here wrongly is a candidate that gets watched, fails to
 * move, and is discarded. The failure modes are not symmetric, so the list
 * errs short.
 */
export const CANDIDATE_VARIABLES: readonly string[] = [
  // 1. Every name on a verified row in companion-state-source.ts, READ OFF THE
  //    TABLE rather than copied out of it, so a row added there joins the probe
  //    list without anybody remembering to. Today that is `power_state`,
  //    `power`, `powerState`, `status`, `recording`, `streaming`,
  //    `stream_status` and `record_status`.
  ...new Set(Object.values(STATE_SOURCES).flatMap((rows) => rows.map((r) => r.name))),
  // 2. The common shapes the table does NOT already supply. Nothing here may
  //    repeat a name from the group above — the two lists are concatenated, not
  //    de-duplicated, so a name in both would be two GETs for one answer and
  //    would make the group above dead weight nobody would notice was gone.
  "power_status",
  "state",
  "record_state",
  "stream_state",
  "on_off",
  "is_on",
  "active",
  "enabled",
  "mute",
  "muted",
  "connected",
];

/** Every `<label>:<name>` worth probing for these connections. */
export function candidateRefs(labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    for (const name of CANDIDATE_VARIABLES) {
      const ref = `${label}:${name}`;
      // A label Companion sanitised to something the ref grammar refuses
      // cannot be read back at all. Dropped here rather than sent, so the
      // probe never builds a URL that answers 404 for the wrong reason.
      if (isCompanionVariableRef(ref) && !out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

/** What one candidate has been seen to do across the presses so far. */
export interface CandidateObservation {
  /** What it held once the device settled after an ON press, or absent. */
  on?: string;
  /** What it held once the device settled after an OFF press, or absent. */
  off?: string;
  /**
   * Every distinct value it has ever settled to, in the order first seen.
   *
   * A candidate that has taken THREE values is not a two-state variable and is
   * disqualified — a clock, a counter, a scene name. Without this, a `status`
   * variable reading `Standby`, `Warming`, `Active` would bind on the first
   * ON/OFF pair of readings and then read unknown every time the device passed
   * through the third.
   */
  values: string[];
}

/** How far along learning is for one pair. Stored on the `_on` half. */
export interface LearningState {
  /** How many presses have been observed without a binding coming out. */
  attempts: number;
  /** Per candidate ref, what it has been seen to do. */
  observed: Record<string, CandidateObservation>;
  /**
   * Why learning is over, or absent while it is still going.
   *
   * `bound` and `gave-up` both stop the probe. They are kept — rather than the
   * params being deleted — because a cleared binding must NOT restart learning:
   * an operator who unbound a pair on purpose would otherwise have it re-probed
   * and re-bound by the next reconcile. "Learn again" is the only thing that
   * clears this. See learnAgainParams.
   */
  stopped?: "bound" | "gave-up";
  /** When the candidates were last probed, ISO — the hourly cap. */
  probedAt?: string;
}

/** Nothing observed yet. */
const EMPTY: LearningState = { attempts: 0, observed: {} };

/**
 * How many observed presses learning gets before it stops.
 *
 * Three, because two is the minimum that could ever succeed (one ON, one OFF)
 * and a third covers the ordinary case of the first press being the wrong
 * direction — a pair pressed OFF while the device was already off moves
 * nothing, and that press has to be spent rather than counted against a pair
 * that would learn on the next two.
 */
export const LEARN_MAX_ATTEMPTS = 3;

/**
 * The learning state in a cue's trigger params.
 *
 * JSON, not the comma-joined encoding `aliases` and `stateCandidates` use, and
 * the reason is the VALUES. A candidate's value is arbitrary text a device
 * chose — `Standby`, `1`, `Rec, paused` — and a delimiter-joined encoding of
 * one that happens to contain the delimiter reads back as two values, which is
 * a binding built from a value no variable ever held. Names are safe to join
 * because Companion sanitises them to letters, digits, `_`, `-` and `.`;
 * values are not.
 *
 * Unparseable is EMPTY rather than an error: a hand-edited rules file must not
 * be able to stop a cue loading, and learning starting over is the whole cost.
 */
export function parseLearning(params: Record<string, string | number>): LearningState {
  const raw = String(params.stateLearning ?? "").trim();
  if (!raw) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY;
  const rec = parsed as Record<string, unknown>;
  const observed: Record<string, CandidateObservation> = {};
  for (const [ref, entry] of Object.entries(
    typeof rec.observed === "object" && rec.observed && !Array.isArray(rec.observed)
      ? (rec.observed as Record<string, unknown>)
      : {},
  )) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const observation: CandidateObservation = {
      values: Array.isArray(e.values)
        ? e.values.filter((v): v is string => typeof v === "string")
        : [],
    };
    if (typeof e.on === "string") observation.on = e.on;
    if (typeof e.off === "string") observation.off = e.off;
    observed[ref] = observation;
  }
  const state: LearningState = {
    attempts: Number.isFinite(rec.attempts) ? Math.max(0, Math.trunc(Number(rec.attempts))) : 0,
    observed,
  };
  if (rec.stopped === "bound" || rec.stopped === "gave-up") state.stopped = rec.stopped;
  if (typeof rec.probedAt === "string" && rec.probedAt) state.probedAt = rec.probedAt;
  return state;
}

/** The candidate refs recorded on a cue, in the order they were probed. */
export function parseCandidates(params: Record<string, string | number>): string[] {
  return String(params.stateCandidates ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && isCompanionVariableRef(s));
}

/**
 * The stored form of a probe result or an observation. Every key is written,
 * blank for none, for the same reason stateBindingParams writes all three:
 * a key left out of a patch keeps its old value, so a candidate list that
 * shrank would keep the names that no longer exist.
 */
export function learningParams(
  candidates: readonly string[],
  state: LearningState,
): Record<string, string> {
  return {
    stateCandidates: candidates.join(","),
    stateLearning: JSON.stringify(state),
  };
}

/** What "learn again" writes: both keys blank, so the next probe starts over. */
export function learnAgainParams(): Record<string, string> {
  return { stateCandidates: "", stateLearning: "" };
}

/**
 * Is this pair still worth probing?
 *
 * `bound` and `gave-up` both stop. A pair inside the hourly window is skipped
 * too — the reconcile runs hourly, but a Refresh in the picker runs it on
 * demand and a page somebody is clicking about on must not re-probe every
 * connection each time.
 */
export function shouldProbe(
  params: Record<string, string | number>,
  now: number,
  probeEveryMs: number,
): boolean {
  const state = parseLearning(params);
  if (state.stopped) return false;
  if (!state.probedAt) return true;
  const at = Date.parse(state.probedAt);
  // An unparseable timestamp probes: it is a hand-edited or corrupted value,
  // and "never probe again" is the wrong way to fail.
  if (!Number.isFinite(at)) return true;
  return now - at >= probeEveryMs;
}

/** What one observation round saw: the candidate values before and after a press. */
export interface Observation {
  want: "on" | "off";
  /** Value per candidate ref as read at the start of the window. */
  before: Record<string, string>;
  /** Value per candidate ref as read once it settled, or absent when unread. */
  after: Record<string, string>;
}

/** A binding learning has decided on. */
export interface LearnedBinding {
  variable: string;
  onValue: string;
  offValue: string;
}

/** What one observation round decided. */
export interface LearnOutcome {
  /** The state to store — always, even when nothing moved. */
  state: LearningState;
  /** The binding to write, or null when there is not one yet. */
  binding: LearnedBinding | null;
  /** The candidates that also qualified, named on the log line. */
  runnersUp: string[];
  /** Learning has stopped and this is the line to say so, or null. */
  gaveUp: boolean;
}

/**
 * Fold one press's readings into what is already known, and bind if it is
 * enough.
 *
 * A candidate is a HIT for this press when its value CHANGED between the two
 * reads. A press that moved nothing is still an attempt — a pair pressed OFF
 * while its device was already off is the ordinary case, and it has to cost
 * something or a pair that will never learn probes forever.
 *
 * Both directions are needed before anything is bound. A candidate that moved
 * after ON and never after OFF is a variable that reacts to the press without
 * reporting the state — a counter, a `last_command`, a clock — and binding it
 * would be a switch reading on whatever the device is doing.
 */
export function observePress(
  previous: LearningState,
  observation: Observation,
  candidates: readonly string[],
): LearnOutcome {
  const observed: Record<string, CandidateObservation> = {};
  // Carried across from the previous rounds first, so a candidate that moved
  // two presses ago is still remembered.
  for (const [ref, entry] of Object.entries(previous.observed)) {
    if (candidates.includes(ref)) observed[ref] = { ...entry, values: [...entry.values] };
  }

  for (const ref of candidates) {
    const before = observation.before[ref];
    const after = observation.after[ref];
    // Either read failed. Not a hit and not a disqualification: an unreachable
    // Companion mid-window must not make a candidate look static.
    if (before === undefined || after === undefined) continue;
    if (before === after) continue;
    const entry = observed[ref] ?? { values: [] };
    entry[observation.want] = after;
    if (!entry.values.includes(after)) entry.values.push(after);
    observed[ref] = entry;
  }

  const attempts = previous.attempts + 1;
  const qualified = candidates.filter((ref) => qualifies(observed[ref]));
  if (qualified.length > 0) {
    const chosen = pickCandidate(qualified);
    const entry = observed[chosen]!;
    return {
      state: {
        attempts,
        observed,
        stopped: "bound",
        probedAt: previous.probedAt,
      },
      binding: { variable: chosen, onValue: entry.on!, offValue: entry.off! },
      runnersUp: qualified.filter((ref) => ref !== chosen),
      gaveUp: false,
    };
  }

  const gaveUp = attempts >= LEARN_MAX_ATTEMPTS;
  return {
    state: {
      attempts,
      observed,
      ...(gaveUp ? { stopped: "gave-up" as const } : {}),
      probedAt: previous.probedAt,
    },
    binding: null,
    runnersUp: [],
    gaveUp,
  };
}

/**
 * Has this candidate earned a binding?
 *
 * Moved in BOTH directions, to two values that differ, and never to a third.
 * The third-value clause is what keeps a three-state `status` out: it would
 * otherwise be bound on its first two readings and read unknown every time the
 * device passed through the state nobody saw.
 */
function qualifies(entry: CandidateObservation | undefined): boolean {
  if (!entry?.on || !entry.off) return false;
  if (entry.on === entry.off) return false;
  return entry.values.length === 2;
}

/**
 * Which of several qualifying candidates to bind.
 *
 * A power name first, then a status name, then the order they were probed in —
 * which is the order of CANDIDATE_VARIABLES, so the table's own verified names
 * come before the guessed shapes. A plug publishing both `power_state` and
 * `on_off` is a plug whose power is the thing to read, and a name is the only
 * evidence available: both moved the same way at the same moment.
 *
 * The others are LOGGED rather than dropped silently. Two variables that both
 * track a device is the case where this could pick wrong, and the log line is
 * what an operator reads to see there was a choice.
 */
export function pickCandidate(refs: readonly string[]): string {
  const nameOf = (ref: string) => ref.slice(ref.indexOf(":") + 1).toLowerCase();
  return (
    refs.find((ref) => nameOf(ref).includes("power")) ??
    refs.find((ref) => nameOf(ref).includes("status")) ??
    refs[0]!
  );
}

/** The line for a binding learning worked out. */
export function learnedLog(
  base: string,
  binding: LearnedBinding,
  attempts: number,
  runnersUp: readonly string[],
): string {
  const also = runnersUp.length > 0 ? `; also matched ${runnersUp.join(", ")}` : "";
  return (
    `[cues] pair ${base}: learned state source ${binding.variable} ` +
    `(${binding.onValue}/${binding.offValue}) from watching ${attempts} presses${also}`
  );
}

/** The line for giving up. */
export function gaveUpLog(base: string): string {
  return (
    `[cues] pair ${base}: could not learn a state source after ${LEARN_MAX_ATTEMPTS} presses; ` +
    `pick one on the rule`
  );
}

/**
 * What the editor says while learning is waiting for presses.
 *
 * Exported and shared with the renderer so the sentence has one spelling, and
 * so the string a test asserts is the string the field renders.
 */
export function learningHint(candidates: readonly string[]): string {
  return (
    `Learning: watching ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}; ` +
    `press the pair on and off once to bind`
  );
}
