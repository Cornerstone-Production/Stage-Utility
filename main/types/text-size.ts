// The ServiceCue text size: its range and its clamp, in the one place the server
// and the screens both read.
//
// A size is a percentage of the rundown's normal size. A display's is kept by the
// server (Output.textSize), which refuses anything outside this range; the page
// and the stepping controls clamp with the same function, so a size one accepts
// is a size the other does.

export const MIN_TEXT_SIZE = 50;
export const MAX_TEXT_SIZE = 300;
export const DEFAULT_TEXT_SIZE = 100;

/** Round to a whole percent and hold it inside [MIN, MAX]. */
export function clampTextSize(n: number): number {
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, Math.round(n)));
}

/** Whether `n` is a size the server will keep as given: a finite number inside
 *  the range. A size outside it is refused, not clamped — a clamp is for what an
 *  operator types, and a client that sends 900 has a bug worth hearing about. */
export function isStorableTextSize(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_TEXT_SIZE && n <= MAX_TEXT_SIZE;
}
