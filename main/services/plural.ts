// plural.ts — `1 feed` / `2 feeds`, for a count in a sentence an operator reads.
//
// Written out four times: the video service, the video import panel, the data
// archive panel and the repeat log, all but one with the same 2-argument shape.
// Importable from the renderer too (@main/services/plural), like clamp.ts.

/** `n` and `one`, with an "s" unless `n` is 1. `many` for a word that does not
 *  take one: `plural(2, "feed has", "feeds have")` reads "2 feeds have". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
