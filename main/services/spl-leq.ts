// Energy averaging for sound levels.
//
// Decibels are logarithmic, so the arithmetic mean of a series of dB readings is
// not the average level — it understates it, badly, whenever the material is
// dynamic. A worship set that sits at 83 dB and peaks at 102 for one song reads
// ~87 dB by arithmetic mean and ~95 dB by energy, because those loud moments
// carry most of the actual acoustic energy while a linear mean flattens them.
//
// The correct combination is the equivalent continuous level:
//
//   Leq = 10 · log10( (1/N) · Σ 10^(Lᵢ/10) )
//
// which is also what a meter's own LAeq/LCeq means over its window — so folding
// those samples together this way yields the true Leq across a whole plan item,
// where averaging them arithmetically would be an average of averages.

/**
 * Fold one more `sample` (dB) into a running Leq.
 *
 * `leq` is the level so far across `count` samples, or null when this is the
 * first. Accumulating in the level domain rather than keeping a running sum of
 * powers keeps the stored record readable and bounded — the intermediate
 * 10^(L/10) never exceeds ~1e13 for any real-world SPL.
 */
export function addLeqSample(leq: number | null, count: number, sample: number): number {
  if (!Number.isFinite(sample)) return leq ?? 0;
  if (leq == null || count <= 0) return sample;
  const total = count * 10 ** (leq / 10) + 10 ** (sample / 10);
  return 10 * Math.log10(total / (count + 1));
}

/** The Leq of a complete series — the reference the incremental form must match. */
export function leqOf(samples: readonly number[]): number | null {
  const usable = samples.filter((s) => Number.isFinite(s));
  if (usable.length === 0) return null;
  return 10 * Math.log10(usable.reduce((sum, s) => sum + 10 ** (s / 10), 0) / usable.length);
}

/**
 * Combine already-computed Leqs into one, weighted by how many samples each
 * covers.
 *
 *   Leq = 10 · log10( Σ(nᵢ · 10^(Lᵢ/10)) / Σnᵢ )
 *
 * WEIGHTED, because the parts are not the same length. A service is a 30-second
 * welcome, a 25-minute sermon and six songs; averaging their Leqs evenly lets the
 * welcome count as much as the sermon and reports a level nobody experienced.
 * With the weights it is exactly the Leq of the whole service — the same number
 * `leqOf` would give if every sample had been kept and folded in one pass, which
 * is what `combineLeq matches leqOf over the same samples` asserts.
 *
 * Parts with no level, or no samples, are skipped rather than counted as zero:
 * an item the meter never reported during is absent from the average, not a
 * silent stretch pulling it down.
 */
export function combineLeq(
  parts: readonly { leq: number | null | undefined; count: number }[],
): number | null {
  let energy = 0;
  let n = 0;
  for (const p of parts) {
    if (p.leq == null || !Number.isFinite(p.leq) || p.count <= 0) continue;
    energy += p.count * 10 ** (p.leq / 10);
    n += p.count;
  }
  if (n === 0) return null;
  return 10 * Math.log10(energy / n);
}
