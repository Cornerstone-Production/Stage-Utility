// What the capsule says between the two scores.
//
// ESPN hands us one pre-formatted string per sport — "Bot 9th", "2nd Quarter",
// "8/31 - 9:38 PM EDT", "Final". In the panel that string is right: there is room
// for it and it reads as a sentence. In the CAPSULE it was 45px of a 156px item,
// 29% of the whole thing and the widest part that is not a score, which made one
// game a third of the context bar.
//
// A baseball half-inning is the case worth compressing, because it is the one
// that is long AND has a shape: a direction and a number. "Bot 9th" becomes a
// triangle and a 9 — about 20px instead of 45 — and reads faster, because the
// direction is a glyph rather than a word to parse.
//
// EVERY OTHER SPORT KEEPS ITS STRING. "2nd Quarter" compressed the same way
// would read as a down, and a scheduled game's start time is not a period at
// all. This only fires on something that matches a half-inning exactly.

/** Which half of the inning, or the break on either side of it. */
export type Half = "top" | "bottom";

export interface HalfInning {
  half: Half;
  /** The inning, with no ordinal: "9", never "9th". */
  inning: string;
}

/**
 * ESPN's four baseball forms.
 *
 * `Mid` is the break after the top half and `End` the break after the bottom, so
 * each points at the half that has just been played — which is what the triangle
 * shows. A game between innings is not a third state worth a third glyph: the
 * question the capsule answers is "how far through", and the number carries that.
 */
const HALF_INNING = /^(Top|Mid|Bot|End)\s+(\d+)(?:st|nd|rd|th)?$/i;

const HALF_OF: Record<string, Half> = {
  top: "top",
  mid: "top",
  bot: "bottom",
  end: "bottom",
};

/**
 * A half-inning, or null for anything else — another sport's period, a start
 * time, "Final", "Delayed". The caller renders the original string for those.
 */
export function halfInning(shortDetail: string): HalfInning | null {
  const m = HALF_INNING.exec(shortDetail.trim());
  if (!m) return null;
  const half = HALF_OF[m[1].toLowerCase()];
  if (!half) return null;
  return { half, inning: m[2] };
}

/** "Bottom of the 9th" — what the triangle and the number mean, said in full. */
export function halfInningLabel({ half, inning }: HalfInning): string {
  return `${half === "top" ? "Top" : "Bottom"} of the ${ordinal(inning)}`;
}

/** 1 -> 1st, 2 -> 2nd, 3 -> 3rd, 11 -> 11th. For speech, never for the capsule. */
function ordinal(n: string): string {
  const v = Number(n);
  const tens = v % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][v % 10] ?? "th"}`;
}
