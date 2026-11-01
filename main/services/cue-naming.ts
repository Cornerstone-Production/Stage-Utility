// cue-naming.ts — a cue name for any text, that nothing else answers to.
//
// PURE, and shared: the server names the cue of a migrated Button with it, and the
// renderer names the cue of a new one, so the two cannot disagree about what
// `Projectors on` becomes. The renderer imports it through `@main/services`, like
// the rest of the cue grammar.

import type { OwnedBy, Rule } from "../types/automation.js";
import { CALL_TRIGGER_ID, takenCueNames } from "./cue-aliases.js";
import { homeVisibilityParams, isPairHalfName } from "./cue-pairs.js";
import { slugForCue } from "./cue-slug.js";

/** The label every action button was created with, before a blank one meant "use
 *  the action's name". Saved buttons still carry it, and it names nothing. */
const LEGACY_DEFAULT_LABEL = "Action";

/** The label the operator actually chose, or undefined when it is blank or the old
 *  default. A cue is named from this, and a rebound button keeps it. */
export function chosenLabel(label: string | undefined): string | undefined {
  const t = (label ?? "").trim();
  return t && t !== LEGACY_DEFAULT_LABEL ? t : undefined;
}

/** lower_snake_case from any text, by the Companion import's own slug with accents
 *  folded first. "" when nothing usable is left. */
export function cueSlug(text: string): string {
  return slugForCue(text.normalize("NFKD").replace(/[̀-ͯ]/g, ""));
}

/**
 * A cue name for this text that nothing in `taken` answers to.
 *
 * Two traps beyond a plain clash. A name ending `_on` or `_off` reads as half of
 * an ON/OFF pair, and a half with no partner is dropped from the manifest, so a
 * Button labelled "Projectors on" would be bound to a cue that never appears: it
 * gets `_cue` appended. An empty slug (a label of only symbols) falls back to
 * `button`. `prefix` goes in front of the slug, so the pair-half check sees the
 * whole name.
 *
 * `taken` is what `takenCueNames` returns, and a pair's base counts as taken as
 * well as its two halves: the manifest lists a pair under its base.
 */
export function cueNameFor(text: string, taken: ReadonlySet<string>, prefix = ""): string {
  let base = `${prefix}${cueSlug(text) || "button"}`;
  if (isPairHalfName(base)) base = `${base}_cue`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Rule params hold strings and numbers only, and so does every registry param;
 *  anything else on a Button's `params` is not a value to carry. */
export function ruleParams(params: Record<string, unknown> | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}

/** The names the manifest lists: each cue's id and call name, a switch's two halves too. */
interface ManifestNames {
  switches?: readonly { id: string; on: string; off: string }[];
  buttons?: readonly { id: string; cue: string }[];
}

/**
 * Everything a NEW cue's name may not be, for the server and the renderer alike:
 * every cue rule's name and former names, the manifest's ids and call names when
 * there is a manifest (where the cues the app ships appear), and the base of every
 * ON/OFF pair. The manifest lists a pair under its base, so `btn_x` would collide
 * with the pair `btn_x_on` / `btn_x_off` even though no rule is called `btn_x`.
 *
 * The rules alone would miss the built-ins and the manifest alone would miss a cue
 * hidden from Home Assistant on an older server, so both are read.
 */
export function namesTakenForNewCue(rules: readonly Rule[], manifest?: ManifestNames | null): Set<string> {
  const taken = takenCueNames(rules);
  for (const s of manifest?.switches ?? []) {
    taken.add(s.id);
    taken.add(s.on);
    taken.add(s.off);
  }
  for (const b of manifest?.buttons ?? []) {
    taken.add(b.id);
    taken.add(b.cue);
  }
  for (const name of [...taken]) {
    const base = /^(.+)_(on|off)$/.exec(name)?.[1];
    if (base) taken.add(base);
  }
  return taken;
}

/**
 * The rule a Button's own action becomes: Called by name, enabled, allowed during a
 * service (a Button is pressed by hand, mid-service), and kept out of Home Assistant
 * until the operator lists it with the other cues. Every guard in `callByName`
 * applies to it.
 *
 * `ownedBy` makes it the Button's own rule; without it, it is an ordinary cue.
 * `says` is what a voice assistant answers with, `cooldownSec` how long it waits
 * before it may fire again (0 is accepted and built-in cues use it).
 */
export function buttonCueRule(opts: {
  /** What an operator reads in the rules list. */
  name: string;
  cueName: string;
  action: Rule["action"];
  ownedBy?: OwnedBy;
  says?: string;
  cooldownSec?: number;
}): Omit<Rule, "id"> {
  return {
    name: opts.name,
    enabled: true,
    trigger: {
      id: CALL_TRIGGER_ID,
      params: { name: opts.cueName, ...(opts.says === undefined ? {} : { says: opts.says }), ...homeVisibilityParams(true) },
    },
    conditions: [],
    action: opts.action,
    cooldownSec: opts.cooldownSec ?? 0,
    oncePerService: false,
    ...(opts.ownedBy ? { ownedBy: opts.ownedBy } : {}),
  };
}
