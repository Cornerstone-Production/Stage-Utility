// What a Mac output helper may be told to send: a video mode for a DeckLink port
// and a rotation for any output. Both are fields of a screen (Output.videoMode,
// Output.rotation), kept here so the server that validates them and the settings
// panel that offers them read one list.

/** Quarter turns, for a monitor mounted on its side. */
export const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];

export function isRotation(v: unknown): v is Rotation {
  return typeof v === "number" && (ROTATIONS as readonly number[]).includes(v);
}

/** What a screen sends when no mode has been chosen. */
export const DEFAULT_VIDEO_MODE = "1080p59.94";

/**
 * Every video mode name a screen may be set to, sorted.
 *
 * The names are the ones the helper reports from the card: lines then scan
 * (`1080p`, `1080i`) then frame rate. Two branches adding a mode touch different
 * lines of this list. The panel offers the ones a port reported out of these; a
 * mode that is not here is refused by the server, so a port that reports one the
 * list lacks is the case for adding it here, deliberately.
 */
export const VIDEO_MODES = [
  "1080i50",
  "1080i59.94",
  "1080i60",
  "1080p23.98",
  "1080p24",
  "1080p25",
  "1080p29.97",
  "1080p30",
  "1080p50",
  "1080p59.94",
  "1080p60",
  "720p50",
  "720p59.94",
  "720p60",
] as const;

export type VideoMode = (typeof VIDEO_MODES)[number];

export function isVideoMode(v: unknown): v is VideoMode {
  return typeof v === "string" && (VIDEO_MODES as readonly string[]).includes(v);
}

/**
 * The modes to offer for a port: the ones it reported that the server accepts,
 * the house default first and the rest in list order. A port that reported
 * nothing, or nothing the server accepts, is offered the whole accepted list,
 * because an empty choice cannot be made. The mode the screen already has is
 * always kept, so a select never goes blank on a value the server already took.
 */
export function modeChoices(reported: readonly string[] | undefined, current: string | undefined): string[] {
  const offered = (reported ?? []).filter(isVideoMode);
  const pool: readonly string[] = offered.length > 0 ? VIDEO_MODES.filter((m) => offered.includes(m)) : VIDEO_MODES;
  const choices = [...pool].sort((a, b) => Number(b === DEFAULT_VIDEO_MODE) - Number(a === DEFAULT_VIDEO_MODE));
  return current && !choices.includes(current) ? [current, ...choices] : choices;
}
