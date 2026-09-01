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

import { LOUDEST_METER, RECORDER_FOR, STREAMER_FOR } from "../recording-status";

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
  // On the recording card too, which draws a timecode on its sub-line exactly as
  // the streaming card draws a clock on its own. The two sat side by side on Home
  // with one offering the switch and the other not, for no reason anybody chose.
  showElapsed: {
    "stream-status": true,
    "home-streaming": true,
    "home-streaming-resi": true,
    "home-streaming-youtube": true,
    "home-recording": true,
  },
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
  // EVERY pair in this record reaches a render. It is worth saying because for
  // one release it was not true: HomeCard was handed a bare `type`, so the six
  // entries naming a home card wrote a setting into the object that the card
  // drawing it never looked at. HomeCard takes the whole config now, and the
  // last three — the streaming cards — were wired with it.
  //
  // "Reaches a render" means on at least one of the two surfaces the object is
  // drawn on, not on both. `hideWhenIdle` and `fillWhenLive` on a streaming card
  // are the wall twin's, deliberately: Home draws these as Stats in a row of
  // Stats, and the same object on a console fills and hides. The menu still
  // offers them there because they are the same object, and the tick has to tell
  // the truth about the config it writes.
  //
  // card-toggle-parity.test.tsx renders every pair here, both ways, and requires
  // the output to differ.
  showProgress: { "pvp-layers": true, "home-pvp": true, "pvp-now": true, "home-pvp-now": true },
  showNextCue: { "pvp-now": true, "home-pvp-now": true },
  // The SPL trend line on Home's Recent services card. History's copy of the
  // same switch lives in settings rather than here, because that chart is not a
  // layout object and has no config to write into.
  showSpl: { "home-recent-services": true },
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
  // Which Smaart meter the SPL card reads. `spl-meter` is listed because it
  // carries the key and the record is exhaustive — the compiler requires it —
  // not because a wall object is expected on Home. If one ever is, offering the
  // same choice there is the honest thing anyway.
  meterId: { "home-spl": true, "spl-meter": true },
  // Which recorder the Home card answers for. This is what retires the OBS and
  // REAPER cards: they were `<RecordingCard recorder="OBS" />` and
  // `recorder="REAPER"` — one component, one prop — so the prop becomes a choice
  // and three palette entries become one.
  recorder: { "home-recording": true },
  // The same move for streaming, whose three cards were `<StreamingCard />` with
  // one prop changed. `stream-status` carries the key too and the record is
  // exhaustive, so it is named here; the wall object's own picker is unchanged.
  platform: { "home-streaming": true, "stream-status": true },
  // Which metric that line plots. A choice from a list this file cannot know —
  // Smaart names the metrics and the card offers the ones history actually has.
  splMetric: { "home-recent-services": true },
} satisfies { [K in PickKey]: Record<TypesWith<K>, true> };

type PickKey = "game" | "meterId" | "recorder" | "platform" | "splMetric";

/**
 * What a card is doing when it has never been given a value for a pick.
 *
 * Per-key, not one shared string: "auto" is what an untouched scores card does,
 * and the loudest meter is what an untouched SPL card does. A single fallback
 * would tick the wrong row on one of them, and the only job of this table is
 * that the menu agrees with the renderer.
 */
const PICK_FALLBACK: Record<PickKey, string> = {
  game: "auto",
  meterId: LOUDEST_METER,
  recorder: "any",
  platform: "any",
  // The empty string is "follow the preferred default" — the menu ticks the
  // metric that default resolved to, so the row that is checked is the one being
  // drawn rather than a placeholder nobody chose.
  splMetric: "",
};

/** The choices each pick offers, for the picks whose list is FIXED. `game` and
 *  `meterId` are absent because their options come from live data the menu
 *  fetches; these two are the app's own vocabulary and cannot change at runtime. */
export const PICK_OPTIONS: Partial<Record<PickKey, Readonly<Record<string, string | null>>>> = {
  recorder: RECORDER_FOR,
  platform: STREAMER_FOR,
};

/** Every (widget type, pick) pair the menu can write, flattened — the picks'
 *  half of TOGGLE_PAIRS, and walked by the same guard. */
export const PICK_PAIRS: readonly { type: string; key: PickKey }[] = Object.entries(
  PICKS as Record<string, Record<string, true>>,
).flatMap(([key, types]) => Object.keys(types).map((type) => ({ type, key: key as PickKey })));

/**
 * Every (widget type, setting) pair the menu can write, flattened.
 *
 * Derived from APPLIES rather than written out, so it cannot fall behind it —
 * the guard that renders each pair both ways is only worth having if the list it
 * walks is the list the menu uses.
 */
export const TOGGLE_PAIRS: readonly { type: string; key: ToggleKey }[] = Object.entries(
  APPLIES as Record<string, Record<string, true>>,
).flatMap(([key, types]) => Object.keys(types).map((type) => ({ type, key: key as ToggleKey })));

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
  // A card saved before the field existed has no value, and neither has one
  // explicitly set to null — both are doing whatever PICK_FALLBACK names.
  return typeof value === "string" ? value : PICK_FALLBACK[key];
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
  | "showNextCue"
  | "showSpl";

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
  // `false` to agree with the renderer: a card that has never been told draws
  // attendance alone, exactly as it did before the line existed.
  { key: "showSpl", label: "SPL trend line", fallback: false },
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
