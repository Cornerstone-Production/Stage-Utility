// backoff.ts — how long to wait before trying again.

/** How long to wait after `failures` failures in a row: minMs, doubling, up to maxMs. */
export function backoffMs(failures: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, minMs * 2 ** Math.max(0, failures - 1));
}
