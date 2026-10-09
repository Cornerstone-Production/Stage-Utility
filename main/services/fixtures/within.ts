// within.ts — a test's wait on a promise, bounded on the real clock.

/** `work`'s result, or a throw naming `what` once `ms` of real time pass
 *  first: a seam that never goes idle fails the test that awaited it, instead
 *  of hanging the suite until CI's job limit. Polled on setImmediate and
 *  performance.now(), neither of which a test's mocked timers touch, so it
 *  bounds a wait inside a test that mocks setTimeout too. */
export async function within<T>(work: Promise<T>, what: string, ms = 5000): Promise<T> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  // Past the deadline nobody awaits `watched`; the timeout below is the
  // test's failure, and a late rejection after it is not a second one.
  watched.catch(() => {});
  const deadline = performance.now() + ms;
  while (!settled) {
    if (performance.now() > deadline) throw new Error(`still waiting after ${ms} ms for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return watched;
}
