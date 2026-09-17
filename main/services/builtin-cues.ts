// builtin-cues.ts — the cues this app ships, so a panel button, a Home
// Assistant switch and a Companion toggle can drive OBS, REAPER,
// ProVideoPlayer and the app itself with no automation rule behind them.
//
// A cue IS a rule, and that is right: one definition feeds the cue button,
// Home Assistant and Companion at once, with idempotent calls, a settle window
// and an activity-log line. But a button that starts a REAPER recording used to
// cost two rules named as a pair, and nothing about those rules is automation.
// The pieces the pair collapses to — an ON action, an OFF action and an `app:`
// state source — are already fixed by the actions themselves (see
// `implicitStateBinding` in cue-pairs.ts). So the app states them once, here.
//
// SYNTHESISED, NEVER STORED. `builtinCueRules` returns ordinary `Rule` objects
// with a `builtin:` id, built fresh on every read from the integration flags and
// the last ProVideoPlayer status. `automationEngine.listRules()` never sees one,
// so the Automation page, the export, the import and the config snapshot are
// unchanged and nothing is written to disk. `rulesWithBuiltins()` is what the
// cue readers use; see automation-engine.ts.
//
// NAMES ARE RESERVED. `assertCueValid` refuses a new or edited rule that takes
// a built-in's cue name. A rule that ALREADY holds one keeps working and the
// built-in with that base is left out, with a line saying so — that is how an
// install which built its own OBS pair last week upgrades without a duplicate
// entity in Home Assistant, and how it discovers it can delete the pair.
//
// THE SET CHANGES. Enabling an integration, disabling one, or ProVideoPlayer
// reporting different layer names changes what is offered, so this watches both
// channels and bumps the manifest version through the same path a rule change
// takes. A PVP that goes offline keeps its last layers listed (state unknown)
// rather than dropping every entity until it reconnects.

import { addBroadcastListener } from "./broadcaster.js";
import {
  appStateFamilyRef,
  appStateRef,
  type AppStateFamilyId,
  type AppStateSourceId,
} from "./app-state-sources.js";
import { CALL_TRIGGER_ID, parseAliases } from "./cue-aliases.js";
import { errorMessage } from "./errors.js";
import { stateBindingParams, type StateBinding } from "./cue-pairs.js";
import { integrationManager } from "./integration-manager.js";
import { pvpService } from "./pvp-service.js";
import { scrub } from "./scrub.js";
import type { IntegrationId } from "./integration-ids.js";
import type { Rule } from "../types/automation.js";

/** What every built-in rule's id starts with. Nothing stored may look like this. */
export const BUILTIN_ID_PREFIX = "builtin:";

/** Is this rule one the app synthesised rather than one the operator saved? */
export function isBuiltinRule(rule: Pick<Rule, "id">): boolean {
  return rule.id.startsWith(BUILTIN_ID_PREFIX);
}

/**
 * How a cue button colours a switch.
 *
 * `default` is green ring when on and grey when off. `live` is for a switch
 * whose ON means on air or recording: red when on, green when the device is
 * connected and off, which reads as standby. Absent means `default`, so a
 * user-made pair — which has no tone setting yet — is unchanged.
 */
export type CueTone = "live";

/** Which integration a built-in belongs to, for the count line. */
type BuiltinGroup = "obs" | "reaper" | "pvp" | "app";

/** One ON/OFF pair the app ships. */
export interface BuiltinSwitchDef {
  base: string;
  /** What to call it on a screen — the manifest's `name`. */
  name: string;
  on: Rule["action"];
  off: Rule["action"];
  /** Where the state is read from. See the note on `impliedBinding` below. */
  binding: StateBinding;
  tone?: CueTone;
  group: BuiltinGroup;
}

/** One momentary cue the app ships. */
export interface BuiltinButtonDef {
  base: string;
  name: string;
  action: Rule["action"];
  group: BuiltinGroup;
}

const action = (id: string, params: Record<string, string | number> = {}): Rule["action"] => ({
  id,
  params,
});

/**
 * A binding to one of the fixed `app:` sources.
 *
 * Both values are `on` / `off` because every source in APP_STATE_SOURCES
 * reports those two; the fixed switches below are checked against
 * `implicitStateBinding` in the tests, so a source that ever changed them would
 * fail there rather than read unknown here.
 */
const appBinding = (id: AppStateSourceId): StateBinding => ({
  variable: appStateRef(id),
  onValue: "on",
  offValue: "off",
});

/** A binding to one member of a parameterised family, for one PVP layer. */
const familyBinding = (
  family: AppStateFamilyId,
  layer: string,
  invert = false,
): StateBinding => ({
  variable: appStateFamilyRef(family, layer),
  onValue: invert ? "off" : "on",
  offValue: invert ? "on" : "off",
});

/**
 * The switches that do not depend on anything but their integration's flag.
 *
 * Each is offered while its integration is ENABLED in Settings, not while it is
 * connected: a console button for a recorder that is switched off at the wall
 * has to be there to be pressed when somebody plugs it back in, and its state
 * reads unknown in the meantime, which is the truth.
 */
const FIXED_SWITCHES: readonly (BuiltinSwitchDef & { integrationId: IntegrationId })[] = [
  {
    base: "obs_record",
    name: "OBS recording",
    integrationId: "obs",
    group: "obs",
    on: action("obs.record", { command: "start" }),
    off: action("obs.record", { command: "stop" }),
    binding: appBinding("obs.recording"),
    tone: "live",
  },
  {
    base: "obs_stream",
    name: "OBS stream",
    integrationId: "obs",
    group: "obs",
    on: action("obs.stream", { command: "start" }),
    off: action("obs.stream", { command: "stop" }),
    binding: appBinding("obs.streaming"),
    tone: "live",
  },
  {
    base: "obs_virtual_cam",
    name: "OBS virtual camera",
    integrationId: "obs",
    group: "obs",
    on: action("obs.virtual-cam", { command: "start" }),
    off: action("obs.virtual-cam", { command: "stop" }),
    binding: appBinding("obs.virtualCam"),
  },
  {
    base: "reaper_record",
    name: "REAPER recording",
    integrationId: "reaper",
    group: "reaper",
    on: action("reaper.transport", { command: "record" }),
    off: action("reaper.transport", { command: "stop" }),
    binding: appBinding("reaper.recording"),
    tone: "live",
  },
];

/** Exported for the exact-count guard and for the manifest's tone lookup. */
export const BUILTIN_FIXED_SWITCHES = FIXED_SWITCHES;

/**
 * The buttons that do not depend on a PVP layer, with what has to be true for
 * each to be offered.
 *
 * `pco_advance` is the one gated on CONNECTED rather than enabled: advancing
 * Live is a call to Planning Center's API, and an account that is not connected
 * has nothing to advance. The other two drive something on this network.
 */
const FIXED_BUTTONS: readonly (BuiltinButtonDef & {
  requires: { enabled?: IntegrationId; connected?: IntegrationId };
})[] = [
  {
    base: "pvp_clear_workspace",
    name: "Clear PVP workspace",
    group: "pvp",
    action: action("pvp.clear-workspace"),
    requires: { enabled: "pvp" },
  },
  {
    base: "pco_advance",
    name: "Next item",
    group: "app",
    action: action("pco.live.advance"),
    requires: { connected: "planning-center" },
  },
  {
    base: "display_refresh",
    name: "Refresh displays",
    group: "app",
    action: action("display.refresh"),
    requires: {},
  },
];

/** Exported for the exact-count guard. */
export const BUILTIN_FIXED_BUTTONS = FIXED_BUTTONS;

/** The per-layer switches and button, as the spec's table states them. */
export function layerSwitches(layer: string, slug: string): BuiltinSwitchDef[] {
  return [
    {
      base: `pvp_${slug}_shown`,
      name: `${layer} shown`,
      group: "pvp",
      // "Shown" is the OPERATOR'S direction: a lit button means the layer is on
      // screen. The family reads `on` while the layer is HIDDEN, so the binding
      // is inverted through the two values a StateBinding already carries
      // rather than through a second state source that says the same thing
      // backwards.
      on: action("pvp.unhide-layer", { layer }),
      off: action("pvp.hide-layer", { layer }),
      binding: familyBinding("pvp.layer-hidden", layer, true),
    },
    {
      base: `pvp_${slug}_muted`,
      name: `${layer} muted`,
      group: "pvp",
      on: action("pvp.mute-layer", { layer }),
      off: action("pvp.unmute-layer", { layer }),
      binding: familyBinding("pvp.layer-muted", layer),
    },
  ];
}

export function layerButtons(layer: string, slug: string): BuiltinButtonDef[] {
  return [
    {
      base: `pvp_${slug}_clear`,
      name: `Clear ${layer}`,
      group: "pvp",
      action: action("pvp.clear-layer", { layer }),
    },
  ];
}

/**
 * A layer name as the part of a cue name it becomes: `Lower Thirds` →
 * `lower_thirds`.
 *
 * A cue name is a URL and a Home Assistant entity id, so it has to be
 * lower_snake_case (see isValidCueName) whatever the operator called the layer
 * in ProVideoPlayer. Everything that is not a letter or a digit becomes one
 * underscore, and a run of them collapses — "Lower Thirds / 2" is
 * `lower_thirds_2`, not `lower_thirds___2`, which is not a usable cue name at
 * all.
 *
 * A layer whose name has no letters or digits in it slugs to "" and is SKIPPED
 * by the caller rather than offered as `pvp__shown`.
 */
export function layerSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The seams. Tests replace all four; nothing else should.
 *
 * `changed` reaches cue-live through a DYNAMIC import for the same reason
 * cue-manifest's `rules` reaches the engine that way — cue-live imports
 * cue-manifest, which is read through the engine, and a static import here
 * would close a cycle through both.
 */
export const builtinCuesDeps: {
  /** The ids of every integration switched on in Settings. */
  enabled: () => ReadonlySet<string>;
  /** The ids of every integration currently connected. */
  connected: () => ReadonlySet<string>;
  /** The layer names in the last ProVideoPlayer status, in PVP's order. */
  pvpLayers: () => readonly string[];
  /** The built-in set changed: bump the manifest version and say so. */
  changed: () => void;
} = {
  enabled: () => new Set(integrationManager.getStates().filter((s) => s.enabled).map((s) => s.id)),
  connected: () =>
    new Set(
      integrationManager.getStates().filter((s) => s.connection === "connected").map((s) => s.id),
    ),
  pvpLayers: () => pvpService.getLatest().layers.map((l) => l.name),
  changed: () => {
    // Fire and forget, so a `.catch` rather than a bare `void`: there is no
    // caller to hand a failure back to — the bus does not await a listener —
    // and a rejected import here is every integration never hearing that the
    // set changed, with nothing anywhere saying so. The log is the caller.
    import("./cue-live.js")
      .then((m) => {
        m.cueLive.rulesChanged();
      })
      .catch((err: unknown) => {
        console.error(
          `[cues] could not announce the built-in set changing: ${scrub(errorMessage(err))}`,
        );
      });
  },
};

/**
 * The last non-empty layer list seen while PVP was enabled.
 *
 * A PVP that goes offline publishes PVP_OFFLINE, whose `layers` is empty — so
 * reading the status alone would take every layer's three entities out of Home
 * Assistant the moment the machine sleeps and put them back on reconnect.
 * Entities that churn are automations that break, so the last list is kept and
 * the states simply read unknown. Cleared when PVP is disabled, which is the
 * operator saying they are done with it.
 */
let lastLayers: readonly string[] = [];

/** The PVP layers to offer built-ins for right now. */
function currentLayers(enabled: ReadonlySet<string>): readonly string[] {
  if (!enabled.has("pvp")) {
    lastLayers = [];
    return [];
  }
  const live = builtinCuesDeps.pvpLayers();
  if (live.length > 0) lastLayers = [...live];
  return lastLayers;
}

/** Every built-in as its definition, before any suppression. */
function offeredDefs(): { switches: BuiltinSwitchDef[]; buttons: BuiltinButtonDef[] } {
  const enabled = builtinCuesDeps.enabled();
  const connected = builtinCuesDeps.connected();
  const switches: BuiltinSwitchDef[] = FIXED_SWITCHES.filter((s) => enabled.has(s.integrationId));
  const buttons: BuiltinButtonDef[] = FIXED_BUTTONS.filter(
    (b) =>
      (b.requires.enabled === undefined || enabled.has(b.requires.enabled)) &&
      (b.requires.connected === undefined || connected.has(b.requires.connected)),
  );
  // One slug per layer, first wins. Two layers called "Lyrics" and "lyrics"
  // slug the same, and a second set of cues under one name is two rules the
  // engine would refuse from anybody else — the manifest would carry one entity
  // driving whichever layer PVP listed first, silently.
  const taken = new Set<string>();
  for (const layer of currentLayers(enabled)) {
    const slug = layerSlug(layer);
    if (!slug || taken.has(slug)) continue;
    taken.add(slug);
    switches.push(...layerSwitches(layer, slug));
    buttons.push(...layerButtons(layer, slug));
  }
  return { switches, buttons };
}

/** One synthesised rule. */
function rule(opts: {
  cue: string;
  name: string;
  action: Rule["action"];
  cooldownSec: number;
  binding?: StateBinding;
}): Rule {
  return {
    id: `${BUILTIN_ID_PREFIX}${opts.cue}`,
    name: opts.name,
    enabled: true,
    trigger: {
      id: CALL_TRIGGER_ID,
      params: {
        name: opts.cue,
        // `says` is what the manifest and the generated Home Assistant config
        // call this on a screen; see spokenCueName. The rule's own `name` is
        // never used for that — a rule may be called "Rule 4".
        says: opts.name,
        ...(opts.binding ? stateBindingParams(opts.binding) : {}),
      },
    },
    // NONE, deliberately. A panel button has to work during a service, which is
    // exactly when every condition an operator might reach for would refuse it.
    conditions: [],
    action: opts.action,
    cooldownSec: opts.cooldownSec,
    oncePerService: false,
  };
}

/** The cue names one built-in occupies — two for a switch, one for a button. */
export function builtinCueNames(base: string, kind: "switch" | "button"): string[] {
  return kind === "switch" ? [`${base}_on`, `${base}_off`] : [base];
}

/**
 * Every cue name a built-in would take, whatever is enabled right now.
 *
 * The WHOLE table, not the offered subset: a name is reserved so that a rule
 * saved today does not collide with a built-in that appears the moment somebody
 * enables OBS. `assertCueValid` reads this.
 *
 * PVP layer names are not in it — they are the operator's own words, and
 * reserving `pvp_lyrics_shown` on an install that has a layer called Lyrics
 * would refuse a rule that was legal yesterday. A stored rule holding one of
 * those simply suppresses the built-in, which is the other half of the design.
 */
export function reservedCueNames(): Set<string> {
  const out = new Set<string>();
  for (const s of FIXED_SWITCHES) for (const n of builtinCueNames(s.base, "switch")) out.add(n);
  for (const b of FIXED_BUTTONS) out.add(b.base);
  return out;
}

/**
 * The built-in rules to offer beside `stored`.
 *
 * Suppression is by cue NAME, including former names: a rule that already
 * answers to `obs_record_on` owns that URL, and offering the built-in beside it
 * would be two rules under one name — which is the thing `assertCueValid`
 * exists to prevent.
 */
export function builtinCueRules(stored: readonly Rule[]): Rule[] {
  const owners = new Map<string, string>();
  for (const r of stored) {
    if (r.trigger.id !== CALL_TRIGGER_ID) continue;
    const label = r.name || String(r.trigger.params.name ?? r.id);
    const name = String(r.trigger.params.name ?? "").trim().toLowerCase();
    if (name && !owners.has(name)) owners.set(name, label);
    for (const alias of parseAliases(r.trigger.params)) {
      if (!owners.has(alias)) owners.set(alias, label);
    }
  }

  const { switches, buttons } = offeredDefs();
  const out: Rule[] = [];
  const counts = new Map<BuiltinGroup, number>();
  const suppressed: string[] = [];
  const bump = (group: BuiltinGroup): void => {
    counts.set(group, (counts.get(group) ?? 0) + 1);
  };

  const ownedBy = (base: string, names: string[]): string | null => {
    for (const n of names) {
      const owner = owners.get(n);
      if (owner) {
        suppressed.push(`${base} not offered: rule "${owner}" owns ${n}`);
        return owner;
      }
    }
    return null;
  };

  for (const s of switches) {
    const names = builtinCueNames(s.base, "switch");
    if (ownedBy(s.base, names)) continue;
    // The BINDING lives on the `_on` half, exactly as a stored pair's does; see
    // cuePairs, which reads the off half only as a fallback for a hand edit.
    out.push({
      ...rule({ cue: names[0]!, name: s.name, action: s.on, cooldownSec: 0, binding: s.binding }),
    });
    out.push(rule({ cue: names[1]!, name: s.name, action: s.off, cooldownSec: 0 }));
    bump(s.group);
  }
  for (const b of buttons) {
    if (ownedBy(b.base, [b.base])) continue;
    // ONE second, where a switch half has none. A switch is idempotent — the
    // call route reads the state and presses nothing when the device is already
    // there — and a button has nothing to read, so the cooldown is the only
    // thing between a double tap and two advances of Planning Center Live.
    out.push(rule({ cue: b.base, name: b.name, action: b.action, cooldownSec: 1 }));
    bump(b.group);
  }

  reportOffered(counts, suppressed);
  return out;
}

/**
 * Say what is offered, for the log and nothing else.
 *
 * Called once when the engine finishes loading its rules, because the count
 * line is otherwise emitted only by the first READ of the manifest — and an
 * install with no Home Assistant and no panel open never reads it, so an
 * operator looking at `/log` after a boot found nothing at all about the cues
 * their console is bound to. Change-gated like every other emission of it, so
 * this is the only line unless the set moves.
 */
export function logBuiltinCues(stored: readonly Rule[]): void {
  builtinCueRules(stored);
}

/** The tone for a built-in switch's base, or undefined for the default one. */
export function builtinTone(base: string): CueTone | undefined {
  return FIXED_SWITCHES.find((s) => s.base === base)?.tone;
}

/**
 * The last count line and the last suppression set this process reported.
 *
 * The rules are rebuilt on every manifest read — a poll, a subscribe, a version
 * bump — and a line per build would bury the log by lunchtime. Only a CHANGE is
 * worth reading: an operator wondering why an entity appeared or vanished wants
 * the moment it did.
 */
let reportedCounts = "";
let reportedSuppressed = "";

function reportOffered(counts: Map<BuiltinGroup, number>, suppressed: string[]): void {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const parts = (["obs", "reaper", "pvp", "app"] as const)
    .filter((g) => (counts.get(g) ?? 0) > 0)
    .map((g) => `${g} ${counts.get(g)!}`)
    .join(", ");
  const line = `${total} built-in cues offered${parts ? ` (${parts})` : ""}`;
  if (line !== reportedCounts) {
    reportedCounts = line;
    console.log(`[cues] ${scrub(line)}`);
  }
  const key = suppressed.join("|");
  if (key !== reportedSuppressed) {
    reportedSuppressed = key;
    for (const s of suppressed) console.log(`[cues] built-in ${scrub(s)}`);
  }
}

/** Exposed for tests: forget what was last logged and what PVP last reported. */
export function __resetBuiltinCues(): void {
  reportedCounts = "";
  reportedSuppressed = "";
  lastLayers = [];
  lastSignature = null;
}

/**
 * The OFFERED set, as one comparable string.
 *
 * The cue names themselves, not the inputs they are derived from. Built from
 * the inputs, this said "something changed" for every integration in the app:
 * switching ProPresenter on offers no built-in and must not make every Home
 * Assistant entity re-read, and a ProVideoPlayer that drops off the network
 * publishes an empty layer list without changing what is offered — the last
 * layers are kept deliberately — so that flapped the version on every
 * reconnect, which is the churn this whole design avoids.
 *
 * Suppression is deliberately not in it: it depends on the stored rules, and a
 * change to those already bumps the version through the engine's rulesChanged.
 */
function signature(): string {
  const { switches, buttons } = offeredDefs();
  return [...switches.map((s) => s.base), ...buttons.map((b) => b.base)].join(",");
}

let lastSignature: string | null = null;

/**
 * An integration flag or a PVP layer name may have changed: if the built-in set
 * moved, the manifest has a new version and anything watching should re-read.
 *
 * Seeded on the FIRST call rather than compared against "": boot publishes a
 * status on every channel, and a bump for each of them at start-up is a
 * manifest re-read per integration for a set that has not changed.
 *
 * It also RECORDS the layers, through offeredDefs, which is why the listener
 * below runs on `pvp:status` whether or not the version moves: the retention
 * that keeps a layer's entities alive across a disconnect would otherwise
 * depend on somebody having read the manifest while PVP was up, and a server
 * that booted with PVP already offline would forget layers it had been told
 * about on the channel.
 */
export function builtinInputsChanged(): void {
  const next = signature();
  if (lastSignature === null) {
    lastSignature = next;
    return;
  }
  if (next === lastSignature) return;
  lastSignature = next;
  builtinCuesDeps.changed();
}

// Registered at import, not at server start, for the same reason cue-live's
// listeners are: this module is loaded by the engine well before anything can
// subscribe, and a registration that depended on boot ordering is a manifest
// that silently never changes.
addBroadcastListener((channel) => {
  if (channel === "integrations:state-changed" || channel === "pvp:status") {
    builtinInputsChanged();
  }
});
