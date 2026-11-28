/** The wait before the next retry: `first` after a clean start (`current` 0), then doubling up to `max`. */
export function nextRetryDelay(current: number, first: number, max: number): number {
  return Math.min(max, current === 0 ? first : current * 2);
}
