// first-free.ts — "base, else base-2, base-3 … until nothing answers to it".

/**
 * `base` when `isTaken` refuses it, else the first `join(base, n)` for n = 2, 3 …
 * that it refuses. `join` is where a caller keeps its own rule for where the
 * suffix goes (a hyphen, an underscore, a space, or trimming `base` to fit a
 * length limit first).
 */
export function firstFree(base: string, isTaken: (candidate: string) => boolean, join: (base: string, n: number) => string = (b, n) => `${b}-${n}`): string {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = join(base, n);
    if (!isTaken(candidate)) return candidate;
  }
}

/**
 * "<prefix> <n>" for the first n from `start` up that `isTaken` refuses: the default
 * name of a new thing ("OSC target 3"). `start` is where a caller wants numbering to
 * begin, usually one past the list's length so a first thing is "… 1". Counting the
 * list alone hands out a name already in use once one in the middle is deleted.
 */
export function firstFreeNumbered(prefix: string, isTaken: (candidate: string) => boolean, start = 1): string {
  let n = start;
  while (isTaken(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/**
 * A `join` for firstFree that keeps the result within `max` characters: the base
 * gives up the room the "-n" suffix needs, and loses any hyphen the cut leaves at
 * its end.
 */
export function truncatingJoin(max: number): (base: string, n: number) => string {
  return (base, n) => {
    const suffix = `-${n}`;
    return `${base.slice(0, max - suffix.length).replace(/-+$/g, "")}${suffix}`;
  };
}
