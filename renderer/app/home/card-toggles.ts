// The few settings a Home widget offers on right-click.
//
// PURE. Home is not the inspector and must not become it — "the default should
// work 90% of the time" is the whole point of the widget work. So this is a
// short list of the settings somebody reaches for on their own front page, and
// everything else stays in the layout editor.
//
// WHICH widgets offer which setting is enforced by the TYPE CHECKER, not by a
// hand-kept list and not by reading the registry's default config. `TypesWith`
// distributes over LayoutObjectConfig and picks out exactly the members that
// declare a key, and `Record<TypesWith<K>, true>` then fails to compile in both
// directions: a type missing from a list is an error, and a type that does not
// support the setting is an error too.
//
// That is deliberate. Deriving it from each widget's default config instead read
// correctly and was quietly wrong — `clock` supports `showMeridiem` and
// `stream-status` supports `hideWhenIdle` and `fillWhenLive`, and none of the
// three appear in those widgets' defaults, so all three would have been silently
// missing from the menu. A second copy of the inspector's per-type switch would
// have had the same failure the first time somebody added a widget.

import type { LayoutObject, LayoutObjectConfig } from "@main/types/views";

/** The members of the config union that declare `K`, by their `type`. */
type TypesWith<K extends PropertyKey, T = LayoutObjectConfig> = T extends { type: infer N }
  ? K extends keyof T
    ? N
    : never
  : never;

/** Every setting Home is willing to show, in menu order, with the exhaustive set
 *  of widgets that support it. The values are `true` purely to make the record's
 *  keys the assertion; nothing reads them. */
const APPLIES = {
  showSeconds: { clock: true },
  format: { clock: true },
  showMeridiem: { clock: true },
  showTimecode: { "obs-status": true },
  showPosition: { "reaper-status": true },
  showElapsed: { "stream-status": true, "home-streaming": true, "home-streaming-resi": true, "home-streaming-youtube": true },
  showProjectedEnd: { "service-pacing": true },
  warnStates: { "pp-timer": true },
  hideWhenIdle: {
    "countdown-timer": true,
    "service-pacing": true,
    "pp-timer": true,
    "record-status": true,
    "obs-status": true,
    "reaper-status": true,
    "stream-status": true,
    "home-streaming": true,
    "home-streaming-resi": true,
    "home-streaming-youtube": true,
  },
  fillWhenLive: { "stream-status": true, "home-streaming": true, "home-streaming-resi": true, "home-streaming-youtube": true },
  fillWhenRecording: { "record-status": true, "obs-status": true, "reaper-status": true },
  // ProVideoPlayer's hairline progress rule, on all four PVP widgets. ONE name
  // for one idea, so an operator learns it once — and the exhaustive record is
  // what makes that a promise rather than an intention: a fifth type carrying
  // `showProgress` and not listed here fails the build.
  //
  // These two are the first entries that a Home card actually READS. Every
  // setting above is written into the object and ignored by the card that drew
  // it, because HomeCard only ever received a type; it takes the whole config
  // now, so a switch here changes what Home draws.
  showProgress: { "pvp-layers": true, "home-pvp": true, "pvp-now": true, "home-pvp-now": true },
  showNextCue: { "pvp-now": true, "home-pvp-now": true },
} satisfies { [K in ToggleKey]: Record<TypesWith<K>, true> };

/**
 * Settings that are a CHOICE FROM A LIST this file cannot know.
 *
 * `game` names one of the teams the scores integration is following, which is
 * config the operator edits in Settings and this module has no business
 * fetching. So the menu builds the options (see gameOptions) and this file keeps
 * the one thing it is for: which widgets support the setting, checked by the
 * compiler. A config member that carries `game` and is not named here fails the
 * build, exactly as for a toggle.
 *
 * Not folded into SPECS: every entry there is a two-way flip with a `next` value
 * computed from the current one, and a list of nine teams is not that.
 */
const PICKS = {
  game: { scores: true, "home-scores": true },
} satisfies { [K in PickKey]: Record<TypesWith<K>, true> };

type PickKey = "game";

/** Every setting Home's menu can write into a card's config. */
export type SettingKey = ToggleKey | PickKey;

/**
 * This card's value for a picked setting, or null if it does not have one.
 *
 * Null rather than a thrown error or a bare boolean, because the menu asks
 * before it knows: it calls this for every card and only draws the submenu when
 * an answer comes back.
 */
export function pickedValue(card: LayoutObject, key: PickKey): string | null {
  const config = card.config as Config;
  if (!((config.type as string) in PICKS[key])) return null;
  const value = config[key];
  // "auto" is the fallback for `game` on both widgets, and it is what a card
  // saved before the field existed was already doing.
  return typeof value === "string" ? value : "auto";
}

type ToggleKey =
  | "showSeconds"
  | "format"
  | "showMeridiem"
  | "showTimecode"
  | "showPosition"
  | "showElapsed"
  | "showProjectedEnd"
  | "warnStates"
  | "hideWhenIdle"
  | "fillWhenLive"
  | "fillWhenRecording"
  | "showProgress"
  | "showNextCue";

/** What to call each setting, and what "on" means for it. `format` is the only
 *  one that is not a boolean. */
const SPECS: {
  key: ToggleKey;
  label: string;
  /** For a two-way choice: the stored values meaning on and off. */
  choice?: { on: string; off: string };
  /** The renderer's fallback when the object never set the key. It must match
   *  what layout-renderer actually does, or an untouched widget shows a tick for
   *  a setting it is not using. */
  fallback: boolean | string;
  /**
   * Per-type overrides, for a setting whose fallback is not the same everywhere.
   *
   * `showProgress` is the case: the hairline rule is OFF on a list of layers,
   * where four of them stacked in a tile is a texture, and ON in the single
   * readout, where there is exactly one and it is part of the composition. One
   * fallback for both would make the menu wrong on one of them, and "the menu
   * agrees with the renderer" is the only job this field has.
   */
  fallbackFor?: Record<string, boolean | string>;
}[] = [
  { key: "showSeconds", label: "Seconds", fallback: true },
  { key: "format", label: "24-hour", choice: { on: "24h", off: "12h" }, fallback: "12h" },
  { key: "showMeridiem", label: "AM / PM", fallback: true },
  { key: "showTimecode", label: "Timecode", fallback: false },
  { key: "showPosition", label: "Position", fallback: false },
  { key: "showElapsed", label: "Elapsed time", fallback: true },
  // `false` to agree with the renderer: absent means the pacing card leads with
  // the drift, which is what every card already on a Home page does.
  { key: "showProjectedEnd", label: "Projected end time", fallback: false },
  { key: "warnStates", label: "Colour on warning", fallback: true },
  { key: "hideWhenIdle", label: "Hide when idle", fallback: false },
  // `true` to agree with the renderer. Home draws these cards as Stats and
  // ignores the setting, but the SAME object on a wall is filled unless this is
  // explicitly off — a tick reading "unfilled" for a widget that fills would be
  // the menu lying about the config it writes.
  { key: "fillWhenLive", label: "Fill the card when live", fallback: true },
  { key: "fillWhenRecording", label: "Fill the card when recording", fallback: true },
  // The fallbacks agree with the renderer, which is what this field is for. The
  // rule is OFF on a list and ON in the single readout, and both cards default
  // to what their own renderer does — a tick that disagreed would be the menu
  // lying about the config it writes.
  {
    key: "showProgress",
    label: "Progress bar",
    fallback: false,
    fallbackFor: { "pvp-now": true, "home-pvp-now": true },
  },
  { key: "showNextCue", label: "Next cue", fallback: true },
];

export interface CardToggle {
  key: ToggleKey;
  label: string;
  checked: boolean;
  /** The config value to write when this is picked. */
  next: boolean | string;
}

type Config = Record<string, unknown>;

/**
 * The settings this card offers, with their current state.
 *
 * `showMeridiem` on a 24-hour clock is dropped rather than shown disabled: it
 * has no effect there, so a switch for it is worse than no switch. The inspector
 * hides it under the same condition.
 */
export function togglesFor(card: LayoutObject): CardToggle[] {
  const config = card.config as Config;
  const type = config.type as string;
  const supports = (key: ToggleKey) => type in (APPLIES[key] as Record<string, true>);
  const valueOf = (spec: (typeof SPECS)[number]) =>
    spec.key in config ? config[spec.key] : spec.fallbackFor?.[type] ?? spec.fallback;

  // Found by key, not by index. This read `SPECS[1]`, which was the `format`
  // spec only because it happened to sit second in the list: inserting or
  // reordering anything above it left `is24h` silently reading a different
  // spec's fallback, and a 24-hour clock would start offering an AM/PM switch
  // that does nothing.
  //
  // A null check rather than a `!`: SPECS is an array, so nothing at the type
  // level says a "format" spec is in it. If one is ever removed, a clock reads
  // as 12-hour instead of throwing.
  const formatSpec = SPECS.find((s) => s.key === "format");
  const is24h = supports("format") && formatSpec != null && valueOf(formatSpec) === "24h";

  const out: CardToggle[] = [];
  for (const spec of SPECS) {
    if (!supports(spec.key)) continue;
    if (spec.key === "showMeridiem" && is24h) continue;
    if (spec.choice) {
      const checked = valueOf(spec) === spec.choice.on;
      out.push({
        key: spec.key,
        label: spec.label,
        checked,
        next: checked ? spec.choice.off : spec.choice.on,
      });
    } else {
      const checked = valueOf(spec) === true;
      out.push({ key: spec.key, label: spec.label, checked, next: !checked });
    }
  }
  return out;
}

/** The card with one setting changed. Returns a NEW object — the caller writes
 *  it through the same save path every other Home edit uses. */
export function withToggle(
  card: LayoutObject,
  key: SettingKey,
  next: boolean | string,
): LayoutObject {
  return { ...card, config: { ...(card.config as Config), [key]: next } as LayoutObject["config"] };
}
