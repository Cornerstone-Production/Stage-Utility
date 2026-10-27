// lyrics-config.ts — what a Lyrics object's settings mean, and the one list of
// their choices.
//
// No React, no DOM. The renderer, the inspector and the tests all read the same
// resolved settings and the same option lists, so the words an operator sees on a
// control are the words the renderer is keyed on.
//
// Every stored field is optional and an unset one reads as the approved default
// below: a saved object never needs rewriting when a setting is added.

import type { LayoutObjectConfig } from "@main/types/views";

export type LyricsConfig = Extract<LayoutObjectConfig, { type: "lyrics" }>;

/** Every setting with its value resolved. Nothing optional. */
export type LyricsSettings = Required<Omit<LyricsConfig, "type" | "propresenterInstanceId">>;

/** The approved default. Also what a new Lyrics object is created with. */
export const LYRICS_DEFAULTS: LyricsSettings = {
  display: "above",
  tagStyle: "filled",
  tagColor: "propresenter",
  tagText: "named",
  tagWidth: "column",
  size: "l",
  weight: "bold",
  align: "left",
  noWords: "tag",
  under: true,
  underShows: "group",
  underWords: false,
  underDim: "light",
  showTitle: false,
};

/** A config with every unset setting read as its default. */
export function lyricsSettings(c: LyricsConfig): LyricsSettings {
  // Not a spread over the defaults: an explicit `undefined` or null (what a JSON
  // round trip or an inspector patch can leave) must still read as the default.
  const out = { ...LYRICS_DEFAULTS };
  function take<K extends keyof LyricsSettings>(key: K): void {
    const v = c[key];
    if (v == null) return;
    // A value this build does not know (a newer build's backup, a hand-edited file) reads as
    // the default: a choice must be one of its key's options, a switch must be a boolean.
    if (typeof v !== typeof LYRICS_DEFAULTS[key]) return;
    const options: readonly { value: unknown }[] | undefined = (LYRICS_OPTIONS as Record<string, readonly { value: unknown }[]>)[key];
    if (options && !options.some((o) => o.value === v)) return;
    out[key] = v as LyricsSettings[K];
  }
  for (const key of Object.keys(LYRICS_DEFAULTS) as (keyof LyricsSettings)[]) take(key);
  return out;
}

/** The settings that are a choice from a list of words (the rest are switches). */
export type LyricsChoice = { [K in keyof LyricsSettings]: LyricsSettings[K] extends string ? K : never }[keyof LyricsSettings];

/** Choices for each setting, in the order the inspector lists them. */
export const LYRICS_OPTIONS: { [K in LyricsChoice]: readonly { value: LyricsSettings[K]; label: string }[] } = {
  display: [
    { value: "beside", label: "Beside" },
    { value: "above", label: "Above" },
    { value: "strip", label: "Arrangement" },
  ],
  tagStyle: [
    { value: "filled", label: "Filled" },
    { value: "outline", label: "Outline" },
    { value: "text", label: "Text" },
  ],
  tagColor: [
    { value: "propresenter", label: "ProPresenter" },
    { value: "one", label: "One colour" },
  ],
  tagText: [
    { value: "named", label: "As named" },
    { value: "short", label: "Short" },
    { value: "caps", label: "CAPS" },
  ],
  tagWidth: [
    { value: "column", label: "Column" },
    { value: "fit", label: "Fit" },
  ],
  size: [
    { value: "fit", label: "Fit" },
    { value: "s", label: "S" },
    { value: "m", label: "M" },
    { value: "l", label: "L" },
  ],
  weight: [
    { value: "regular", label: "Regular" },
    { value: "bold", label: "Bold" },
  ],
  align: [
    { value: "left", label: "Left" },
    { value: "center", label: "Centre" },
  ],
  noWords: [
    { value: "blank", label: "Blank" },
    { value: "tag", label: "Tag only" },
  ],
  underShows: [
    { value: "slide", label: "Next slide" },
    { value: "group", label: "Next group" },
  ],
  underDim: [
    { value: "light", label: "A little" },
    { value: "strong", label: "More" },
  ],
};

/**
 * The size of the lyric as a fraction of the object's own box height, for the
 * fixed sizes. Fit is not here: it is measured, not chosen.
 *
 * Box height, not the canvas, so the same setting means the same proportion on a
 * wall object, a Home tile and an embedded view. 0.124 is 62px in the 500px box
 * the approved mockup draws, and M and S are its 46px and 36px.
 */
export const LYRICS_SIZE_OF_BOX = { s: 0.072, m: 0.092, l: 0.124 } as const;

/** The groups ProPresenter names so often that a short form is fixed, not derived. */
const KNOWN_SHORT: Readonly<Record<string, string>> = {
  verse: "V",
  chorus: "C",
  "pre-chorus": "PC",
  prechorus: "PC",
  "pre chorus": "PC",
  bridge: "B",
  tag: "T",
};

/** Names that stay whole: already short, and "I" and "O" read as nothing. */
const STAYS_WHOLE = new Set(["intro", "outro"]);

/** The first character of a word, by code point, in capitals. */
function initial(word: string): string {
  return (Array.from(word)[0] ?? "").toUpperCase();
}

/**
 * A group name as a short tag: "Verse 1" becomes V1, "Chorus" C, "Pre-Chorus" PC,
 * "Bridge" B, "Tag" T. Intro and Outro stay whole. Anything else is its first
 * letters, capped at 3: the initials of its words when it has several ("Post
 * Chorus" is PC), else its first letters ("Instrumental" is INS). A trailing number
 * is kept and counts against the 3 ("Interlude 2" is IN2), so Instrumental 1 and
 * Instrumental 2 stay apart.
 *
 * Derived only. The name itself is never rewritten; this is what the Short setting
 * draws.
 */
export function shortGroupName(name: string): string {
  const full = name.trim();
  if (!full) return "";
  if (STAYS_WHOLE.has(full.toLowerCase())) return full;

  const m = /^(.*?)\s*(\d+)?$/.exec(full);
  const base = (m?.[1] ?? full).trim();
  const num = m?.[2] ?? "";
  // A name that is only a number ("2") has no letters to shorten.
  if (!base) return num;

  const known = KNOWN_SHORT[base.toLowerCase()];
  if (known) return known + num;

  const words = base.split(/[\s\-_/]+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words.map(initial).join("")
      : Array.from(base).slice(0, 3).join("").toUpperCase();
  // Room for the number inside the cap, but never less than one letter.
  const room = Math.max(1, 3 - num.length);
  return Array.from(letters).slice(0, room).join("") + num;
}

/** The tag's words under the Text setting. */
export function tagLabel(name: string, text: LyricsSettings["tagText"]): string {
  if (text === "short") return shortGroupName(name);
  if (text === "caps") return name.toUpperCase();
  return name;
}
