// The running maximum behind an SPL meter's peak-hold mode.
//
// It lives outside the component because it has to be exactly right: the value is
// adjusted during render, so a version that never settles would spin React into
// "Too many re-renders" rather than merely showing a wrong number. Returning the
// SAME object when nothing changed is what makes that impossible — the caller
// only re-renders on a different identity, and applying this twice is a no-op.

/** A held peak, tagged with the source it was measured from. */
export interface PeakHold {
  /** Identifies meter + metric + mode; a change invalidates the hold. */
  key: string;
  peak: number | null;
}

/**
 * The hold after observing `sample`. Returns `hold` unchanged when there is
 * nothing to record, so `next !== hold` is a safe re-render condition.
 *
 * A `key` change resets the hold in the same step that records the new sample,
 * so switching meter or metric can never leave the previous source's peak on
 * screen — the reset cannot be overwritten by the sample arriving with it.
 */
export function advancePeakHold(hold: PeakHold, key: string, sample: number | null, holding: boolean): PeakHold {
  const held = hold.key === key ? hold.peak : null;
  const peak = holding && sample != null ? (held == null ? sample : Math.max(held, sample)) : held;
  return hold.key === key && peak === hold.peak ? hold : { key, peak };
}
