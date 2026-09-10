// cue-manifest.ts — every cue, said once, for something that is not a browser.
//
// The Home Assistant fragment (home-assistant-yaml.ts) is a file an operator
// pastes: it is generated once, saved, and goes stale the moment somebody adds
// a cue. That is fine for a config file and wrong for an INTEGRATION, which has
// to discover what exists and notice when it changes.
//
// So this is the same information as JSON, plus the two things a config file
// cannot carry: a VERSION that goes up whenever the rules change, and each
// switch's current state. An integration reads it once, subscribes to the
// `cues` channel (cue-live.ts), and re-reads only when the version moves.
//
// Two kinds, because Home Assistant has two:
//
//   switches  an ON/OFF pair — two cues, one thing to turn on and off. A
//             TOGGLE pair is still a switch; `toggle: true` says both halves
//             press one key, which matters only to somebody drawing it.
//   buttons   a single cue. Momentary; there is nothing to read back.
//
// AN UNAVAILABLE CUE IS STILL LISTED. A cue whose Companion button has gone
// missing cannot be pressed, and dropping it from the manifest would take the
// entity out of Home Assistant entirely — the automations referring to it break
// silently, and it comes back under a fresh name when the button reappears.
// `available: false` says so and keeps the entity.
//
// Open, like `GET /api/cues/states` and the YAML: it carries cue names and
// on/off, never a token.

import { cuePairs, isTogglePair } from "./cue-pairs.js";
import { readFingerprint } from "./companion-fingerprint.js";
import { stageController } from "./stage-controller.js";
import { CALL_TRIGGER_ID } from "./cue-aliases.js";
import type { CueStateName, CueStatesAnswer } from "./cue-states.js";
import type { Rule } from "../types/automation.js";

/** One ON/OFF pair, as a thing to be turned on and off. */
export interface ManifestSwitch {
  /** The pair's base — the id an integration keys its entity on. */
  id: string;
  /** What to call it on a screen. */
  name: string;
  /** The room the operator typed on the cue, or "". */
  room: string;
  /** The cue name to POST to turn it on. */
  on: string;
  off: string;
  /** Both halves press ONE Companion button. See isTogglePair. */
  toggle: boolean;
  state: CueStateName;
  /** Why the state is unknown. Absent for on and off. */
  reason?: string;
  /** The Companion variable the state is read from. Absent for an unbound pair. */
  stateSource?: string;
  /** False when a half's Companion button is missing — it cannot be pressed. */
  available: boolean;
}

/** One cue that is not half of a pair. Momentary; there is nothing to read. */
export interface ManifestButton {
  /** The cue name, which is both the id and what to POST. */
  id: string;
  name: string;
  room: string;
  cue: string;
  available: boolean;
}

export interface CueManifest {
  /** Goes up on every rule change. Nothing else about it means anything. */
  version: number;
  server: { name: string; lanUrl: string | null };
  switches: ManifestSwitch[];
  buttons: ManifestButton[];
}

/**
 * The manifest version, bumped on any rule change.
 *
 * A COUNTER, not a hash of the rules and not a timestamp. A hash would need the
 * whole manifest built to answer "has anything changed", which is what the
 * version exists to avoid, and a timestamp on a server whose clock is UTC and
 * whose day rolls at 19:00 locally is a comparison nobody should have to think
 * about. It starts at 1 on every boot and only ever goes up within a process;
 * an integration that sees it go DOWN has been talking to a restarted server
 * and should re-read, which is the same thing it does when it goes up.
 */
let version = 1;

export function manifestVersion(): number {
  return version;
}

/** The rules changed. Returns the new version, for the caller to announce. */
export function bumpManifestVersion(): number {
  version += 1;
  return version;
}

/**
 * The seams. `rules` reaches the engine through a DYNAMIC import for the same
 * reason cue-states' does — the engine imports the services it drives, and a
 * static import here would close a cycle through it.
 */
export const cueManifestDeps: {
  rules: () => Promise<readonly Rule[]>;
  states: () => Promise<CueStatesAnswer>;
} = {
  rules: async () => (await import("./automation-engine.js")).automationEngine.listRules(),
  states: async () => (await import("./cue-states.js")).cueStates.read(),
};

/**
 * Every cue, with each pair's current state.
 *
 * The state comes from cueStates, which is the same five-second cached read
 * `GET /api/cues/states` and the live channel use — so an integration polling
 * the manifest and a browser with the rules list open share one round of reads.
 */
export async function cueManifest(): Promise<CueManifest> {
  const rules = await cueManifestDeps.rules();
  const pairs = cuePairs(rules);
  // Only when something is bound. An install with no bound pair must not pay a
  // Companion round trip to be told so, and `read()` on no bound pairs is an
  // empty answer anyway — this skips the promise, not the work.
  const states = pairs.some((p) => p.binding) ? await cueManifestDeps.states() : null;

  const paired = new Set<string>();
  const switches: ManifestSwitch[] = [];
  for (const pair of pairs) {
    paired.add(pair.on.id);
    paired.add(pair.off.id);
    const row = states?.states[pair.base];
    const entry: ManifestSwitch = {
      id: pair.base,
      name: spokenName(pair.on, pair.base),
      room: roomOf(pair.on) || roomOf(pair.off),
      on: pair.onName,
      off: pair.offName,
      toggle: isTogglePair(pair),
      // No binding is `unknown` with no reason, exactly as an unbound pair
      // reads everywhere else: nobody can say, and nothing failed.
      state: row?.state ?? "unknown",
      available: pressable(pair.on) && pressable(pair.off),
    };
    if (row?.reason) entry.reason = row.reason;
    if (pair.binding) entry.stateSource = pair.binding.variable;
    switches.push(entry);
  }

  const buttons: ManifestButton[] = [];
  for (const rule of rules) {
    if (rule.trigger.id !== CALL_TRIGGER_ID || paired.has(rule.id)) continue;
    const cue = String(rule.trigger.params.name ?? "").trim().toLowerCase();
    if (!cue) continue;
    buttons.push({
      id: cue,
      name: spokenName(rule, cue),
      room: roomOf(rule),
      cue,
      available: pressable(rule),
    });
  }

  const state = stageController.getState();
  return {
    version,
    server: { name: state.appName, lanUrl: state.lanUrl ?? null },
    switches,
    buttons,
  };
}

/**
 * What to call a cue on a screen.
 *
 * The operator's own `says` first, because that is the words they chose — with
 * a trailing "on" taken off a pair's ON half, which is there so the cue can be
 * SAID and is not part of the thing's name. "Projectors on" is a sentence; the
 * switch is called Projectors.
 *
 * Falling back to the cue name humanised, never to the rule's `name` field: a
 * rule may be called anything, and "Rule 4" in a house full of switches is
 * worse than "Room A Screens Projectors".
 */
function spokenName(rule: Rule, fallback: string): string {
  const says = String(rule.trigger.params.says ?? "").trim();
  const stripped = says.replace(/\s+on$/i, "").trim();
  if (stripped) return stripped;
  return fallback
    .split("_")
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function roomOf(rule: Rule): string {
  return String(rule.trigger.params.room ?? "").trim();
}

/**
 * Can this cue press anything?
 *
 * False only for a `companion.press` whose button the reconcile has marked
 * missing. A cue with some other action, or one whose button has never been
 * picked, is not something this can say no about.
 */
function pressable(rule: Rule): boolean {
  if (rule.action.id !== "companion.press") return true;
  return readFingerprint(rule.action.params).status !== "missing";
}
