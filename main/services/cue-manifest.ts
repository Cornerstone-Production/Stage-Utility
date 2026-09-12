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
// A HIDDEN CUE IS NOT LISTED, and that is the one case where losing the entity
// is the intent: the operator turned the cue's Home Assistant switch off, so it
// is voice-only from here. Home Assistant removes the entity within seconds and
// automations there that refer to it stop working — which is why it takes a
// deliberate action and never happens because something failed. Both halves of
// a hidden pair stay accounted for as a pair, so neither leaks out as a button.
//
// Open, like `GET /api/cues/states` and the YAML: it carries cue names and
// on/off, never a token.

import { cuePairs, isHiddenFromHome, isTogglePair, spokenCueName } from "./cue-pairs.js";
import { readFingerprint } from "./companion-fingerprint.js";
import { scrub } from "./scrub.js";
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
  /**
   * A press was dispatched for this pair inside the last few seconds and
   * `state` may still be from before it. Absent otherwise, never false.
   */
  settling?: true;
  /**
   * What that press asked for. Present exactly when `settling` is, and what an
   * integration should show instead of a reading it has been told is stale.
   */
  commanded?: "on" | "off";
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
  let hidden = 0;
  for (const pair of pairs) {
    // BEFORE the skip: a hidden pair's halves are still a pair, and leaving
    // them out of `paired` would publish both of them as buttons — the entity
    // the operator hid, twice, under different ids.
    paired.add(pair.on.id);
    paired.add(pair.off.id);
    if (pair.hiddenFromHome) {
      hidden += 1;
      continue;
    }
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
    if (row?.settling) {
      entry.settling = true;
      entry.commanded = row.commanded;
    }
    if (pair.binding) entry.stateSource = pair.binding.variable;
    switches.push(entry);
  }

  const buttons: ManifestButton[] = [];
  for (const rule of rules) {
    if (rule.trigger.id !== CALL_TRIGGER_ID || paired.has(rule.id)) continue;
    const cue = String(rule.trigger.params.name ?? "").trim().toLowerCase();
    if (!cue) continue;
    // A cue named like half of a pair whose partner is not here is an ORPHAN,
    // not a button: deleting a pair one half at a time exposed the survivor as
    // a momentary button for the moment between the two deletes, and Home
    // Assistant created and removed an entity for it. Half a switch is not a
    // thing anyone should be able to press from Home.
    if (/_(on|off)$/.test(cue)) continue;
    if (isHiddenFromHome(rule.trigger.params)) {
      hidden += 1;
      continue;
    }
    buttons.push({
      id: cue,
      name: spokenName(rule, cue),
      room: roomOf(rule),
      cue,
      available: pressable(rule),
    });
  }

  reportHidden(hidden);
  const state = stageController.getState();
  return {
    version,
    server: { name: state.appName, lanUrl: state.lanUrl ?? null },
    switches,
    buttons,
  };
}

/**
 * What to call a cue on a screen. See spokenCueName — the rule editor names the
 * same switch, and this module cannot be imported from a renderer.
 */
function spokenName(rule: Rule, fallback: string): string {
  return spokenCueName(rule.trigger.params, fallback);
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

/**
 * The last hidden count this process reported, so an unchanged build says
 * nothing.
 *
 * The manifest is built on every read — a poll, a subscribe, a version bump —
 * and a line per build would bury the log. Only a CHANGE is worth reading: an
 * operator wondering why an entity vanished wants the moment it did.
 */
let reportedHidden = 0;

function reportHidden(count: number): void {
  if (count === reportedHidden) return;
  reportedHidden = count;
  if (count > 0) console.log(`[cues] ${scrub(count)} cue(s) hidden from Home Assistant`);
  else console.log("[cues] no cues are hidden from Home Assistant");
}
