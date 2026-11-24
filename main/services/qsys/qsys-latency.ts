// qsys-latency.ts — a rolling window of durations, for the Q-SYS status.
//
// One is kept (qsys-write.ts): how long the Core took to confirm a write. The window
// is a fixed ring, so memory is bounded however many writes there are, and nothing
// here owns a timer.

/** Samples kept per window; the oldest is overwritten. */
export const LATENCY_WINDOW = 500;

export interface LatencyStats {
  /** Samples in the window now (at most LATENCY_WINDOW). */
  count: number;
  /** Median and 95th percentile in milliseconds, or null while there are no samples. */
  p50: number | null;
  p95: number | null;
}

export class LatencyWindow {
  private readonly samples: number[] = [];
  private next = 0;
  /** Samples taken since the last takeSince(); never reset by the ring wrapping. */
  private since = 0;

  constructor(private readonly size: number = LATENCY_WINDOW) {}

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.samples.length < this.size) this.samples.push(ms);
    else this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.size;
    this.since++;
  }

  /** Nearest-rank percentile of what the window holds, rounded to 0.1 ms. */
  private percentile(sorted: number[], p: number): number {
    const i = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return Math.round(sorted[i] * 10) / 10;
  }

  stats(): LatencyStats {
    if (!this.samples.length) return { count: 0, p50: null, p95: null };
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
    };
  }

  /** How many samples were recorded since the last call, and start counting again. */
  takeSince(): number {
    const n = this.since;
    this.since = 0;
    return n;
  }

  clear(): void {
    this.samples.length = 0;
    this.next = 0;
    this.since = 0;
  }
}
