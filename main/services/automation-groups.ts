// automation-groups.ts — which heading each trigger, condition and action sits
// under in the rule pickers.
//
// PURE: no I/O, no engine, nothing node-only. The settings page imports it, so it
// may name no module that reaches `node:url` (see cue-aliases.ts for the crash
// that is).
//
// The registry holds about a hundred definitions. A flat list of that many is a
// list nobody reads, so the pickers group them — and the grouping is a MAP from
// something a definition already has, not a field on each definition:
//
//  - a trigger by its `channel`, because the channel IS the thing it watches, so
//    a new trigger on a watched channel is grouped without anyone remembering,
//  - an action by the integration its id begins with,
//  - a condition by its id.
//
// A definition this module does not know falls into OTHER_GROUP rather than out
// of the picker: an ungrouped trigger that vanished from the list would be a rule
// nobody can build. automation-groups.test.ts asserts none lands there today, so
// a new channel or action prefix is a failing test, not a heading called Other.

/** The heading for something nothing below claims. */
export const OTHER_GROUP = "Other";

/** Trigger headings, in the order the pickers list them. */
export const TRIGGER_GROUPS = [
  "Service and plan",
  "Recording and streaming",
  "People",
  "Sound",
  "Wireless",
  "ProVideoPlayer",
  "Screens",
  "Baptism",
  "Connections",
  "This app",
] as const;

export type TriggerGroup = (typeof TRIGGER_GROUPS)[number];

/** A trigger's `channel`, to the heading it sits under. */
export const TRIGGER_CHANNEL_GROUPS: Readonly<Record<string, TriggerGroup>> = {
  "pco:live": "Service and plan",
  "service-timeline:history": "Service and plan",
  "obs:status": "Recording and streaming",
  "reaper:status": "Recording and streaming",
  "resi:status": "Recording and streaming",
  "youtube:status": "Recording and streaming",
  "people:count": "People",
  "spl:metrics": "Sound",
  "slots:devices": "Wireless",
  "pvp:status": "ProVideoPlayer",
  "displays:presence": "Screens",
  "baptism:state": "Baptism",
  "integrations:state-changed": "Connections",
  "osc:feedback": "Connections",
  "prodcom:transcript": "Connections",
  "update:status": "This app",
  // The Called by name trigger. No picker offers it as a trigger to choose (a
  // manual cue is made by choosing the kind, not by picking this), but the
  // editor of an ON/OFF half still names it, and it has to be somewhere.
  "cue:call": "This app",
};

/** The heading a trigger sits under, or null when its channel is not mapped. */
export function triggerGroup(channel: string): string | null {
  return Object.hasOwn(TRIGGER_CHANNEL_GROUPS, channel) ? TRIGGER_CHANNEL_GROUPS[channel] : null;
}

/** Action headings, in the order the pickers list them. */
export const ACTION_GROUPS = [
  "Stage Utility",
  "Companion",
  "ProPresenter",
  "ProVideoPlayer",
  "OBS",
  "REAPER",
  "Planning Center",
  "RossTalk",
  "OSC",
] as const;

export type ActionGroup = (typeof ACTION_GROUPS)[number];

/** The word before the first dot of an action id, to the heading it sits under. */
export const ACTION_PREFIX_GROUPS: Readonly<Record<string, ActionGroup>> = {
  log: "Stage Utility",
  display: "Stage Utility",
  messages: "Stage Utility",
  baptism: "Stage Utility",
  companion: "Companion",
  propresenter: "ProPresenter",
  pvp: "ProVideoPlayer",
  obs: "OBS",
  reaper: "REAPER",
  pco: "Planning Center",
  rosstalk: "RossTalk",
  osc: "OSC",
};

/** The heading an action sits under, or null when its prefix is not mapped. */
export function actionGroup(id: string): string | null {
  const prefix = id.split(".")[0] ?? "";
  return Object.hasOwn(ACTION_PREFIX_GROUPS, prefix) ? ACTION_PREFIX_GROUPS[prefix] : null;
}

/** Condition headings, in the order the pickers list them. */
export const CONDITION_GROUPS = [
  "Service and time",
  "Recording and streaming",
  "ProVideoPlayer",
  "Baptism",
  "Connections",
] as const;

export type ConditionGroup = (typeof CONDITION_GROUPS)[number];

/**
 * Condition id prefixes that are not an integration's `<id>.is-connected`.
 *
 * Every `<integration>.is-connected` is a Connections entry whatever the
 * integration is, so those are not listed one by one: a seventeenth integration
 * is grouped by the suffix, not by someone remembering to add it here.
 */
const CONDITION_PREFIX_GROUPS: Readonly<Record<string, ConditionGroup>> = {
  service: "Service and time",
  time: "Service and time",
  obs: "Recording and streaming",
  reaper: "Recording and streaming",
  resi: "Recording and streaming",
  youtube: "Recording and streaming",
  pvp: "ProVideoPlayer",
  baptism: "Baptism",
};

/** The heading a condition sits under, or null when nothing claims it. */
export function conditionGroup(id: string): string | null {
  if (id.endsWith(".is-connected")) return "Connections";
  const prefix = id.split(".")[0] ?? "";
  return Object.hasOwn(CONDITION_PREFIX_GROUPS, prefix) ? CONDITION_PREFIX_GROUPS[prefix] : null;
}
