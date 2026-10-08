// in-flight.ts — work a service started without awaiting, so a caller can wait
// for it to land.
//
// A service that answers an event by starting work it does not await (a
// publish, a probe round, a readiness tick) gives nobody a promise to wait on.
// A test, or anything else that must see that work's effects, used to wait a
// guessed number of event-loop turns; the work reads the disk, and a disk
// read takes however long the machine's load makes it. This holds the real
// promises instead.

export class InFlight {
  private readonly running = new Set<Promise<unknown>>();

  /** Holds `work` until it settles. Returns a promise that settles as `work`
   *  does, for the caller to await or `void`: voided, a rejection still
   *  reaches the process as unhandled, exactly as a bare `void work` did, and
   *  awaited, it is the caller's to handle, with nothing left over. */
  track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    return work.finally(() => this.running.delete(work));
  }

  /** Resolves once nothing tracked is running, including work started while
   *  waiting. Never rejects: whether the work failed is its caller's news. */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }
}
