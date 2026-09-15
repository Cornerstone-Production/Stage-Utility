// Types for the automation engine — "when X happens in Stage, do Y to a device".

import type { PvpLayerDTO } from "./pvp.js";

/** A typed parameter on a trigger, condition or action — renders a form field. */
export interface ParamDef {
  key: string;
  label: string;
  /** "key-value" renders a small two-column table and stores a JSON object string,
   *  so the param shape stays Record<string, string | number>. Used where an
   *  operator must type exact external names (Dante channels) that no template can
   *  safely generate. */
  type: "number" | "string" | "enum" | "multi-enum" | "key-value";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  /** Options that can only be known at runtime (targets, service types, commands). */
  optionsFrom?:
    | "rosstalk-targets"
    | "rosstalk-commands"
    | "osc-targets"
    | "service-types"
    | "displays"
    | "plan-items"
    | "propresenter-instances"
    | "propresenter-macros";
  optional?: boolean;
  help?: string;
  /** Column headings for a "key-value" param. */
  keyLabel?: string;
  valueLabel?: string;
}

export interface TriggerDef {
  id: string;
  label: string;
  /** Broadcast channel to watch, or "clock" for the internal timer. */
  channel: string;
  params: ParamDef[];
  /**
   * PURE. Did this fire on the transition prev -> next?
   * MUST return false when `prev` is null — that is the restart guard.
   */
  didFire(prev: unknown | null, next: unknown, params: Record<string, unknown>, now: number): boolean;
  help?: string;
}

export interface ConditionDef {
  id: string;
  label: string;
  /**
   * The broadcast channel whose snapshot this reads, or null when it reads
   * nothing a producer can throttle (the clock, the current service type).
   *
   * Conditions are PULLED at the moment a rule fires, so they never appear on
   * the bus and the trigger-channel demand loop cannot see them — a rule that
   * triggers on PCO and merely ASKS about a ProVideoPlayer layer would read a
   * snapshot at the idle cadence. automation-engine.ts registers demand by
   * iterating this registry, so the answer lives on the definition.
   *
   * Required, and nullable rather than optional, so a new condition cannot be
   * written without deciding: a hand-maintained table beside the registry lost
   * five entries with the whole suite green.
   */
  channel: string | null;
  params: ParamDef[];
  /** PURE. Does this qualifier hold right now? */
  holds(ctx: ConditionCtx, params: Record<string, unknown>, now: number): boolean;
}

/** The current-state snapshot conditions are evaluated against. */
export interface ConditionCtx {
  /** The live snapshot, or null when Planning Center has not been read.
   *  `startsAtMs` is the countdown target ("preservice") or the service time —
   *  what `service.is-not-live` needs to tell "an hour before" from "next week". */
  pcoLive: { mode: string; serviceTimeId: string | null; startsAtMs: number | null } | null;
  /** Whether the Planning Center integration is set up at all. A null `pcoLive`
   *  means "cannot be read" only if it is; otherwise there is nothing to read and
   *  a cue must not be refused forever. */
  pcoConfigured: boolean;
  serviceTypeId: string | null;
  /** Connection state per integration id, for the `<id>.is-connected` conditions. */
  integrations: Record<string, string>;
  /** Whether each recorder is rolling right now, for the `is-recording` conditions. */
  obsRecording: boolean;
  reaperRecording: boolean;
  /** Whether each streaming platform is on air right now. */
  resiStreaming: boolean;
  youtubeStreaming: boolean;
  /** Current baptism-timer phase, or null when the timer has never run. */
  baptismPhase: string | null;
  /** ProVideoPlayer's layers as of the last poll, or null when the integration
   *  is off or has never connected. Null and empty are DIFFERENT: null is "we do
   *  not know", and every PVP condition declines to hold on it — an unreachable
   *  machine must not make "the workspace has nothing on screen" true. */
  pvpLayers: PvpLayerDTO[] | null;
}

export interface ActionResult {
  ok: boolean;
  detail: string;
}

export interface ActionDef {
  id: string;
  label: string;
  params: ParamDef[];
  /** NEVER throws — a failure is a returned result, so one bad provider cannot
   *  stop the engine or block other rules. */
  run(params: Record<string, unknown>, ctx: { simulate: boolean }): Promise<ActionResult>;
  help?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: { id: string; params: Record<string, string | number> }[];
  action: { id: string; params: Record<string, string | number> };
  /** Seconds since this rule last fired before it may fire again. */
  cooldownSec: number;
  /** Fire at most once per PCO service occurrence (keyed on serviceTimeId). */
  oncePerService: boolean;
  /**
   * A CALLED cue must be asked twice.
   *
   * Only meaningful with the `call.by-name` trigger: the first call answers 202
   * with a short-lived token and does nothing, and a second call carrying that
   * token executes. For the cue that kills the projectors, said out loud, in a
   * room where a voice assistant can mishear.
   *
   * Optional because every rule persisted before this existed lacks it, and
   * absent means false — the safe reading is "no extra step", not "silently
   * refuse to run".
   */
  confirmRequired?: boolean;
}

/**
 * What became of one evaluation of a rule.
 *
 * `skipped` is not a suppression: nothing stopped the rule, the device was
 * already in the state the call asked for and pressing would have been the
 * wrong thing to do. It is its own outcome so an operator reading the activity
 * log can tell "Home Assistant asked again and we did nothing" from
 * "a condition refused it".
 */
export type AutomationOutcome =
  | "fired"
  | "failed"
  | "simulated"
  | "suppressed"
  | "skipped"
  | "condition-not-met";

export interface AutomationLogEntry {
  at: string;
  ruleId: string;
  ruleName: string;
  triggerId: string;
  actionId: string;
  outcome: AutomationOutcome;
  /** The resolved action detail, or the suppression reason. */
  detail: string;
  /**
   * The label of the token that CALLED this rule, when a call is what ran it.
   *
   * Absent for anything the engine fired itself. A cue turns real gear on and
   * off from outside the building; "which of them did that" has to survive in
   * the log, and the token label is the only identity a caller has.
   */
  caller?: string;
}

export interface AutomationSettings {
  simulate: boolean;
  /** Panic — disables every rule regardless of its own enabled flag. */
  disarmed: boolean;
}
