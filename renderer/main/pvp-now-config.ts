// pvp-now-config.ts — the pure decisions behind a ProVideoPlayer "now" widget's
// Layout and its Warn near the end setting, shared by the renderer, the layout
// inspector and Home's card menu so none of them can read a saved object
// differently from the others.
//
// No React, no DOM: every rule here is arithmetic or a lookup, which is what
// lets pvp-now.test.tsx pin the boundaries (30 s is amber, 31 s is not) without
// a render.

import type { PvpNowLayout } from "@main/types/views";

/** The Layout choice, in the order the inspector and Home's menu list it. One
 *  list, so the two cannot name a layout differently. */
export const PVP_NOW_LAYOUT_OPTIONS: { value: PvpNowLayout; label: string; hint: string }[] = [
  { value: "full", label: "Full", hint: "Caption, what is on, and the time left." },
  { value: "compact", label: "Compact", hint: "Two lines: PVP · label, and the countdown." },
  {
    value: "countdown",
    label: "Countdown only",
    hint: "Only the time left, as large as the widget allows. No caption, no names.",
  },
];

/**
 * Which layout a saved widget draws.
 *
 * `layout` wins once it is set. A widget saved before Layout existed has only
 * the old `compact` switch: `true` was the two-line treatment and anything else
 * the three-line one, so that is what it reads as. Nothing is rewritten — the
 * file keeps `compact` until the operator next changes the widget, and the
 * inspector writes `layout` from then on.
 *
 * This is the ONE reader. Views, layout templates, saved groups, imported view
 * files and config backups all carry layout objects, and a migration in any
 * single store would miss the others; reading the old shape here covers every
 * path a widget reaches a screen by.
 */
export function pvpNowLayout(config: { layout?: PvpNowLayout; compact?: boolean }): PvpNowLayout {
  const l = config.layout;
  if (l === "full" || l === "compact" || l === "countdown") return l;
  return config.compact === true ? "compact" : "full";
}

/**
 * The config with a new layout chosen. Writes `layout` and retires the legacy
 * `compact` an older save may still carry: `layout` wins over it either way, but
 * a stale `compact: true` beside `layout: "full"` is a contradiction a reader of
 * the file should not have to resolve. `undefined` drops out of the JSON on the
 * next save.
 *
 * The one writer, used by the inspector and Home's menu alike.
 */
export function withPvpNowLayout<C extends { layout?: PvpNowLayout; compact?: boolean }>(
  config: C,
  layout: PvpNowLayout,
): C & { layout: PvpNowLayout } {
  return { ...config, layout, compact: undefined };
}

/**
 * Which inspector rows the layout leaves unused, each with the reason said under
 * it, or `false` when the row applies. Next cue is drawn by Full only; Label is
 * borrowed by Compact's caption only; Countdown only draws neither, so a greyed
 * row is never a mystery.
 */
export function pvpNowRowStates(layout: PvpNowLayout): { nextCue: string | false; label: string | false } {
  if (layout === "countdown") {
    return { nextCue: "Not shown in Countdown only.", label: "Not shown in Countdown only." };
  }
  return {
    nextCue: layout === "compact" ? "Not shown in Compact." : false,
    label: layout === "full" ? "Used by Compact only." : false,
  };
}

/** The warning thresholds when a widget has not set them. */
export const DEFAULT_WARN_AMBER_SEC = 30;
export const DEFAULT_WARN_RED_SEC = 10;

/** The most a threshold may be set to: an hour, the longest the inspector's
 *  field offers. */
export const WARN_MAX_SEC = 3600;

const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The thresholds a widget warns at, always consistent: red never exceeds amber.
 *
 * A saved or hand-edited config can hold any pair, so the reader enforces the
 * rule rather than trusting the inspector to have. A red above the amber would
 * otherwise never be reached — the time would jump from white straight to red —
 * so it is held at the amber instead, and the two colours arrive together.
 */
export function pvpWarnThresholds(config: { warnAmberSec?: number; warnRedSec?: number }): {
  amberSec: number;
  redSec: number;
} {
  const amberSec = isSeconds(config.warnAmberSec) ? Math.min(config.warnAmberSec, WARN_MAX_SEC) : DEFAULT_WARN_AMBER_SEC;
  const red = isSeconds(config.warnRedSec) ? Math.min(config.warnRedSec, WARN_MAX_SEC) : DEFAULT_WARN_RED_SEC;
  return { amberSec, redSec: Math.min(red, amberSec) };
}

export type PvpWarnTone = "caution" | "over";

/**
 * The tone the time reads in, or null for the ordinary ink.
 *
 * Judged on the SECOND THE DIGITS SHOW. The formatter rounds to the nearest
 * second, so 30.4 s left reads 0:30; comparing the raw number would keep it
 * white for a frame that says 0:30 on the screen and turn amber under a 0:31.
 * "At or under" is inclusive: 0:30 is amber, 0:10 is red, 0:00 is red.
 *
 * Off unless the widget turned it on, so a widget saved before this existed is
 * unchanged.
 */
export function pvpWarnTone(
  remainingSec: number,
  config: { warnNearEnd?: boolean; warnAmberSec?: number; warnRedSec?: number },
): PvpWarnTone | null {
  if (!config.warnNearEnd) return null;
  const shown = Math.round(remainingSec);
  const { amberSec, redSec } = pvpWarnThresholds(config);
  if (shown <= redSec) return "over";
  if (shown <= amberSec) return "caution";
  return null;
}

/**
 * The colour of a tone: the app's semantic caution and over tokens, the same two
 * a Home stat takes when it earns a state colour. They resolve per surface — the
 * dark steps on a stage display, the light ones on Home in the light theme — so
 * the widget needs no second palette for either.
 */
export function pvpWarnColor(tone: PvpWarnTone | null): string | null {
  if (tone === "caution") return "var(--color-warn-11)";
  if (tone === "over") return "var(--color-danger-11)";
  return null;
}

export const COUNTDOWN_HEIGHT_SHARE = 0.62;
export const COUNTDOWN_WIDTH_SHARE = 0.9;
export const MONO_ADVANCE_EM = 0.62;

/**
 * The number's font size in Countdown only: as tall as the box allows, never
 * wider than it.
 *
 * Height first — 62% of the box leaves the digits room above and below — then
 * the width, which depends on how many characters the CURRENT string has: "3:40"
 * is four and "1:05:12" is seven, so the same widget draws the longer one
 * smaller rather than overflowing. A monospace digit is about 0.6 em wide; the
 * measured advance of Plex Mono is 0.6 and the other mono faces the stack falls
 * back to are within a few thousandths of it, so 0.62 is a margin rather than
 * a fudge.
 *
 * Pure arithmetic over the MEASURED box: jsdom reports 0 for both and the answer
 * is 0, which the caller treats as "not measured yet".
 */
export function countdownFontPx(boxW: number, boxH: number, chars: number): number {
  if (!(boxW > 0) || !(boxH > 0) || chars < 1) return 0;
  return Math.min(boxH * COUNTDOWN_HEIGHT_SHARE, (boxW * COUNTDOWN_WIDTH_SHARE) / (chars * MONO_ADVANCE_EM));
}
