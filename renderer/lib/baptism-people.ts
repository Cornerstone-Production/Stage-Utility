import type { BaptismPerson } from "@main/types/stage.js";

/**
 * The counting rule shared by `baptismStats` (link-baptisms.ts, over a set of
 * SESSIONS) and `summarizeBaptism` (main/use-baptism-state.ts, over the LIVE
 * state's own `people`): who counts as baptized, and the raw millisecond sums
 * every average either surface reports divides out of.
 *
 * `baptized` is never `people.length` — a grouped session's `people` fills
 * during the testimony pass, before anyone is baptized, and a session
 * finished mid-testimony leaves an entry with `baptizeMs: 0` behind
 * permanently. Counting `people.length` there is exactly the "counts
 * testimonies" bug that once lived independently in both files this reduction
 * replaces — see baptismStats' own doc comment on `people` for the shape.
 *
 * Deliberately ms and deliberately unitless beyond that: `baptismStats`
 * reports seconds and `summarizeBaptism` reports milliseconds, and neither
 * unit conversion nor field naming belongs in the one rule both share.
 */
export interface BaptismPeopleReduction {
  /** Everyone who testified, baptized or not — the denominator for an
   *  average over testimony time. */
  testified: number;
  /** Only people with a real (> 0) baptizeMs — the denominator for an
   *  average over baptism time. */
  baptized: number;
  totalTestimonyMs: number;
  /** Summed over BAPTIZED people only. */
  totalBaptizeMs: number;
  /** testimonyMs + baptizeMs, summed over BAPTIZED people only — what
   *  summarizeBaptism's own avgPersonMs divides by `baptized`. */
  totalBaptizedPersonMs: number;
}

export function reduceBaptismPeople(people: readonly BaptismPerson[]): BaptismPeopleReduction {
  let testified = 0;
  let baptized = 0;
  let totalTestimonyMs = 0;
  let totalBaptizeMs = 0;
  let totalBaptizedPersonMs = 0;
  for (const p of people) {
    testified += 1;
    totalTestimonyMs += p.testimonyMs;
    if (p.baptizeMs > 0) {
      baptized += 1;
      totalBaptizeMs += p.baptizeMs;
      totalBaptizedPersonMs += p.testimonyMs + p.baptizeMs;
    }
  }
  return { testified, baptized, totalTestimonyMs, totalBaptizeMs, totalBaptizedPersonMs };
}
