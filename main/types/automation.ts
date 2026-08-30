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
  optionsFrom?: "rosstalk-targets" | "rosstalk-commands" | "osc-targets" | "service-types" | "displays" | "plan-items";
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
  params: ParamDef[];
  /** PURE. Does this qualifier hold right now? */
  holds(ctx: ConditionCtx, params: Record<string, unknown>, now: number): boolean;
}

/** The current-state snapshot conditions are evaluated against. */
export interface ConditionCtx {
  pcoLive: { mode: string; serviceTimeId: string | null } | null;
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
}

export type AutomationOutcome = "fired" | "failed" | "simulated" | "suppressed" | "condition-not-met";

export interface AutomationLogEntry {
  at: string;
  ruleId: string;
  ruleName: string;
  triggerId: string;
  actionId: string;
  outcome: AutomationOutcome;
  /** The resolved action detail, or the suppression reason. */
  detail: string;
}

export interface AutomationSettings {
  simulate: boolean;
  /** Panic — disables every rule regardless of its own enabled flag. */
  disarmed: boolean;
}
