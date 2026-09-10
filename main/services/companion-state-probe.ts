// companion-state-probe.ts — the I/O half of learning a state source.
//
// Two jobs, and they are separate in time:
//
//   PROBE   which of the candidate names this connection actually publishes.
//           Once an hour per pair, off the back of the reconcile pass, by
//           asking Companion for each name's value: 200 exists, 404 does not.
//   WATCH   what those names DO when the pair is pressed. Rides a real press —
//           never one of ours — reads the candidates at the start of the settle
//           window and again as they move, and hands the pair of readings to
//           the pure fold in companion-state-learn.ts.
//
// NOTHING IS PRESSED HERE. There is no press call in this file and there must
// never be one: a housekeeping pass that pressed a button to see what happened
// would turn the projectors on during a service.
//
// THE READS GO THROUGH companionApi.readVariable, the same function cue-states'
// own read dep resolves to — one timeout, one 404 sentence, one trim. A second
// fetch path here is a second thing to keep in step with Companion's API.
//
// CONCURRENCY IS CAPPED. A probe is 19 names per connection and this dials a
// Companion that is also running a service, so the requests go out a few at a
// time rather than as one burst of 57. An unreachable Companion stops the whole
// probe on the first failure — every name would fail the same way, and 19
// three-second timeouts is a minute of nothing.

import { companionApi } from "./companion-api.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import {
  type LearningState,
  type LearnedBinding,
  candidateRefs,
  gaveUpLog,
  learnAgainParams,
  learnedLog,
  LEARN_MAX_PROBES,
  learningParams,
  noCandidatesLog,
  observePress,
  parseCandidates,
  parseLearning,
  shouldProbe,
} from "./companion-state-learn.js";
import { stateBindingParams, type CuePair } from "./cue-pairs.js";
import { SETTLE_MS, SETTLE_POLL_MS } from "./cue-states.js";
import type { CompanionButton } from "./companion-export.js";

export { learnAgainParams };

/** How often one pair's candidates are re-probed. */
export const PROBE_EVERY_MS = 60 * 60 * 1000;

/** How many candidate reads are in flight at once. */
const PROBE_CONCURRENCY = 4;

/**
 * The seams. Tests replace all four: `read` is what makes a probe assertable
 * without a Companion, and the two timer functions are what let an eight-second
 * settle window be watched in a millisecond.
 *
 * `updateTrigger` reaches the engine through a DYNAMIC import for the same
 * reason cue-states' `rules` dep does — the engine imports the services it
 * drives, and a static import here would close a cycle through it.
 */
export const stateProbeDeps: {
  now: () => number;
  read: (ref: string) => Promise<{ value: string } | { error: string }>;
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (t: NodeJS.Timeout) => void;
  /** Merge these trigger params onto one cue. Rejects when the write failed. */
  updateTrigger: (ruleId: string, patch: Record<string, string>) => Promise<void>;
} = {
  now: () => Date.now(),
  read: (ref) => companionApi.readVariable(ref),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // A watch that lasts eight seconds must never be what keeps the process
    // alive, and it must never delay a shutdown.
    t.unref();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t),
  updateTrigger: async (ruleId, patch) => {
    const { automationEngine } = await import("./automation-engine.js");
    // RE-READ immediately before the write, never from a snapshot: the watch
    // runs eight seconds after the press and an operator may have saved the
    // rule in between. Every other field of the trigger goes back as it is now.
    const rule = automationEngine.listRules().find((r) => r.id === ruleId);
    if (!rule) throw new Error("the cue was deleted while its state source was being learned");
    await automationEngine.updateRule(rule.id, {
      trigger: {
        ...rule.trigger,
        params: { ...rule.trigger.params, ...patch },
      },
    });
  },
};

/** One pair the probe decided something about. */
export interface ProbeOutcome {
  /** The `_on` half's rule id — the half the binding and the learning live on. */
  ruleId: string;
  base: string;
  /** The trigger params to merge. */
  patch: Record<string, string>;
  /** The line to log, or null when nothing worth one happened. */
  log: string | null;
}

/**
 * Which pairs a probe pass should look at.
 *
 * A pair qualifies when EVERY one of these holds:
 *
 *  - it has NO binding, on either half. An explicit or inferred binding is
 *    never touched, which is the same rule inferBindingPatches follows.
 *  - its `_on` button was found in the export and drives at least one
 *    connection no table row covers. A pair whose button is missing has
 *    nothing to probe, and a pair on a module the table knows already has its
 *    answer.
 *  - it has no inferred source. The table wins: it is verified, and the
 *    reconcile is about to write it as the binding anyway.
 *  - learning has not stopped and it is outside the hourly window.
 *
 * The `_off` half's button is read as a fallback, exactly as the inference
 * offer does: an ON button that is a macro naming no device, beside an OFF
 * button that names one, is a real shape on a real install.
 */
export function probeTargets(
  pairs: readonly CuePair[],
  found: ReadonlyMap<string, CompanionButton>,
  now: number,
): { pair: CuePair; labels: string[] }[] {
  const out: { pair: CuePair; labels: string[] }[] = [];
  for (const pair of pairs) {
    if (pair.binding !== null) continue;
    const on = found.get(pair.on.id);
    const off = found.get(pair.off.id);
    if (on?.stateSource || off?.stateSource) continue;
    // A label Companion sanitised to something `$(label:name)` cannot name —
    // one with a space or a dot in it — yields no refs at all, and a pair with
    // nothing to ask for must not be recorded as probed. Recorded, it would
    // write to the rules file and log a line every pass about a connection
    // that can never be read.
    const labels = [
      ...new Set([...(on?.learnConnections ?? []), ...(off?.learnConnections ?? [])]),
    ].filter((label) => candidateRefs([label]).length > 0);
    if (labels.length === 0) continue;
    if (!shouldProbe(pair.on.trigger.params, now, PROBE_EVERY_MS)) continue;
    out.push({ pair, labels });
  }
  return out;
}

/**
 * Ask Companion which of these refs exist.
 *
 * Returns the refs that answered with a value, IN THE ORDER THEY WERE PROBED,
 * plus their values — which are the baseline the first observation compares
 * against. `null` means Companion could not be reached at all, and the caller
 * must change nothing: an empty list would be recorded as "this connection
 * publishes none of these", and the pair would never be probed again inside the
 * hour.
 *
 * A 404 is not a failure — it is the answer that a name does not exist, which
 * is what this is asking. Anything else (a timeout, a refused connection, a
 * 401) stops the pass.
 */
export async function probeRefs(
  refs: readonly string[],
): Promise<{ existing: string[]; values: Record<string, string> } | null> {
  const existing: string[] = [];
  const values: Record<string, string> = {};
  let unreachable = "";

  for (let i = 0; i < refs.length && !unreachable; i += PROBE_CONCURRENCY) {
    const batch = refs.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ref) => {
        try {
          return { ref, result: await stateProbeDeps.read(ref) };
        } catch (err) {
          // readVariable is documented as never throwing; a rejection here is
          // still returned rather than thrown on, because one bad name must not
          // abandon the batch.
          return {
            ref,
            result: { error: errorMessage(err) } as { error: string },
          };
        }
      }),
    );
    for (const { ref, result } of results) {
      if ("value" in result) {
        existing.push(ref);
        values[ref] = result.value;
        continue;
      }
      // "no such variable X in Companion" is the 404 sentence companion-api
      // writes for a name that does not exist. Anything else is the transport.
      if (!result.error.startsWith("no such variable")) unreachable = result.error;
    }
  }

  if (unreachable) return null;
  // The order of `refs` is preserved: `existing` is pushed batch by batch and
  // Promise.all keeps a batch in order, so a candidate list reads in
  // CANDIDATE_VARIABLES order and pickCandidate's "else the first" is the
  // table's verified names before the guessed shapes.
  return { existing, values };
}

/**
 * Probe every pair that needs it and write what was found.
 *
 * Called by the reconcile pass, which already has the export and the found
 * buttons. Returns the outcomes rather than logging them itself, so the
 * reconcile logs at ONE site with its own scrub — see the barrier note there.
 *
 * A pair whose probe found NOTHING still records the timestamp, so it is not
 * re-probed for an hour. A pair whose probe could not reach Companion records
 * nothing at all.
 */
export async function probeStateCandidates(
  pairs: readonly CuePair[],
  found: ReadonlyMap<string, CompanionButton>,
): Promise<ProbeOutcome[]> {
  const out: ProbeOutcome[] = [];
  for (const { pair, labels } of probeTargets(pairs, found, stateProbeDeps.now())) {
    const probed = await probeRefs(candidateRefs(labels));
    // Companion unreachable. Nothing recorded and nothing logged: the export
    // fetch already wrote `[companion] export unavailable` if it is down, and a
    // second line per learning pair would be the log for the morning.
    if (!probed) return out;
    const previous = parseLearning(pair.on.trigger.params);
    const probes = probed.existing.length === 0 ? (previous.probes ?? 0) + 1 : 0;
    const state: LearningState = {
      ...previous,
      // The baseline for the first observation: what each candidate held when
      // it was probed. Kept as the `values` seen so far so a candidate that
      // never moves is not later mistaken for a two-state variable.
      observed: Object.fromEntries(
        probed.existing.map((ref) => [ref, { values: [probed.values[ref]!] }]),
      ),
      probedAt: new Date(stateProbeDeps.now()).toISOString(),
      probes,
      // A connection that has answered for NONE of the names three times over
      // is a connection that does not publish one. Stopped, so it is not asked
      // 19 times an hour for the rest of the year — Learn again is what retries
      // it. A probe that found something stops asking too, without stopping
      // learning: what happens next is a press. See shouldProbe.
      ...(probes >= LEARN_MAX_PROBES ? { stopped: "gave-up" as const } : {}),
    };
    out.push({
      ruleId: pair.on.id,
      base: pair.base,
      patch: learningParams(probed.existing, state),
      log:
        probed.existing.length > 0
          ? `[cues] pair ${pair.base}: no state source in the table; watching ` +
            `${probed.existing.length} candidate(s) — ${probed.existing.join(", ")}`
          : probes >= LEARN_MAX_PROBES
            ? noCandidatesLog(pair.base, labels)
            : null,
    });
  }
  return out;
}

// ── Watching a press ─────────────────────────────────────────────────────────

/** A watch in progress, keyed by the pair's base. */
interface Watch {
  ruleId: string;
  base: string;
  want: "on" | "off";
  candidates: string[];
  /**
   * What learning knew when the press was dispatched.
   *
   * Carried on the watch rather than re-read eight seconds later, because
   * nothing else writes it in between — the only writer is this file, one watch
   * per pair at a time — and reaching the engine for it would be a second
   * dependency on the engine in a path that already has one for the write.
   */
  previous: LearningState;
  before: Record<string, string>;
  after: Record<string, string>;
  startedAt: number;
  timer: NodeJS.Timeout | null;
}

const watching = new Map<string, Watch>();

/** Exposed for tests: forget every watch in progress. */
export function __resetWatches(): void {
  for (const watch of watching.values()) {
    if (watch.timer) stateProbeDeps.clearTimeout(watch.timer);
  }
  watching.clear();
}

/**
 * A real press was dispatched for a pair that is learning. Watch what moves.
 *
 * NOT AWAITED by the caller, and that is the point: the whole window is eight
 * seconds and a voice assistant is holding the line. The engine calls this
 * after the press has already been answered.
 *
 * THE "BEFORE" READ HAPPENS HERE, after the dispatch rather than in front of
 * it. Companion polls a device on its own interval — one to five seconds is
 * normal, which is the whole reason the settle window exists — so a read
 * issued the moment the press was dispatched still holds the pre-press value,
 * and putting a read in FRONT of the press would make every learning pair's
 * voice call wait on Companion for nothing the caller needs. The plan for this
 * asked for a pre-press snapshot; this is where the code disagrees with it.
 *
 * A second press on the same pair inside a window RESTARTS it: what the first
 * one was measuring is now confounded by the second, and half an observation is
 * how a `last_command` variable gets bound.
 */
export function notePressForLearning(input: {
  ruleId: string;
  base: string;
  want: "on" | "off";
  params: Record<string, string | number>;
}): void {
  const candidates = parseCandidates(input.params);
  const state = parseLearning(input.params);
  // Nothing to watch, or learning is over. Both are the ordinary case for
  // nearly every press in the building, so this is the cheap early return that
  // keeps the press path free of any Companion traffic.
  if (candidates.length === 0 || state.stopped) return;

  const running = watching.get(input.base);
  if (running?.timer) stateProbeDeps.clearTimeout(running.timer);
  const watch: Watch = {
    ruleId: input.ruleId,
    base: input.base,
    want: input.want,
    candidates,
    previous: state,
    before: {},
    after: {},
    startedAt: stateProbeDeps.now(),
    timer: null,
  };
  watching.set(input.base, watch);
  void readAll(watch.candidates)
    .then((values) => {
      // Restarted, or reset, while the first round of reads was in flight.
      if (watching.get(input.base) !== watch) return;
      watch.before = values;
      schedule(watch);
    })
    .catch((err) => {
      // readAll never rejects; this is the belt on a fire-and-forget promise,
      // and it is a warning rather than a silent drop because a watch that
      // vanished is a pair that will never learn with nothing on the log.
      watching.delete(input.base);
      console.warn(
        `[cues] pair ${scrub(input.base)}: could not read its candidates: ${scrub(errorMessage(err))}`,
      );
    });
}

/** Every candidate's value, the ones that could be read. */
async function readAll(refs: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < refs.length; i += PROBE_CONCURRENCY) {
    const batch = refs.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ref) => {
        try {
          return { ref, result: await stateProbeDeps.read(ref) };
        } catch (err) {
          return {
            ref,
            result: { error: errorMessage(err) } as { error: string },
          };
        }
      }),
    );
    // A ref that could not be read is ABSENT rather than "": the pure fold
    // treats an absent reading as "no evidence" and an empty string as a real
    // value a module writes for a device it has not heard from.
    for (const { ref, result } of results) if ("value" in result) out[ref] = result.value;
  }
  return out;
}

function schedule(watch: Watch): void {
  watch.timer = stateProbeDeps.setTimeout(() => {
    void poll(watch);
  }, SETTLE_POLL_MS);
}

/**
 * One re-read of every candidate that has not moved yet.
 *
 * A candidate that HAS moved is dropped from the polling: its settled value is
 * the first one that differs from before the press, and re-reading it for the
 * rest of the window costs seven more GETs to learn nothing. That also makes a
 * variable that flickers back — a momentary `last_command` — read as having
 * moved, which is correct: it moved, and whether it moved in both directions to
 * two values is what decides the binding.
 *
 * Never throws: it is a timer callback and there is nobody to return a failure
 * to. Every failure ends the watch with a line.
 */
async function poll(watch: Watch): Promise<void> {
  if (watching.get(watch.base) !== watch) return;
  watch.timer = null;
  const pending = watch.candidates.filter((ref) => watch.after[ref] === undefined);
  const values = await readAll(pending);
  if (watching.get(watch.base) !== watch) return;
  for (const [ref, value] of Object.entries(values)) {
    if (watch.before[ref] !== undefined && value !== watch.before[ref]) watch.after[ref] = value;
  }

  const done =
    stateProbeDeps.now() - watch.startedAt >= SETTLE_MS ||
    watch.candidates.every((ref) => watch.after[ref] !== undefined);
  if (!done) {
    schedule(watch);
    return;
  }

  watching.delete(watch.base);
  // Every candidate that never moved settles to its pre-press value, which is
  // what the fold compares: absent would read as "could not be read" and a
  // static candidate would never be ruled out.
  const after: Record<string, string> = { ...watch.before, ...watch.after };
  await finish(watch, after);
}

/** Fold the readings in, write the result, log what it decided. */
async function finish(watch: Watch, after: Record<string, string>): Promise<void> {
  const outcome = observePress(
    watch.previous,
    { want: watch.want, before: watch.before, after },
    watch.candidates,
  );
  const patch: Record<string, string> = {
    ...learningParams(outcome.binding ? [] : watch.candidates, outcome.state),
    ...(outcome.binding ? stateBindingParams(outcome.binding) : {}),
  };
  try {
    await stateProbeDeps.updateTrigger(watch.ruleId, patch);
  } catch (err) {
    // NOT swallowed: nothing downstream is waiting on this, so the failure is
    // said on the log with what was lost — the observation is gone and the next
    // press starts the round again, which is what the operator will see.
    console.warn(
      `[cues] pair ${scrub(watch.base)}: could not record what it learned: ${scrub(errorMessage(err))}`,
    );
    return;
  }
  if (outcome.binding) {
    console.log(
      scrub(
        learnedLog(watch.base, outcome.binding, outcome.state.attempts, outcome.runnersUp),
        600,
      ),
    );
    return;
  }
  if (outcome.gaveUp) {
    console.warn(scrub(gaveUpLog(watch.base), 600));
  }
}

/** Re-exported so the engine and the editor agree on one binding shape. */
export type { LearnedBinding };
