// age-label.ts — "now", "3 min", "2 h": how long ago something happened, as a
// stage message's header and its replies say it.

/**
 * Under 45 seconds is "now"; under 90 minutes is minutes; past that, hours. Both
 * ends are instants on the SERVER's clock, so a wall whose own clock is out still
 * reads right, and an instant stamped ahead of the clock is never negative.
 */
export function ageLabel(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  const m = Math.max(1, Math.round(s / 60));
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}
