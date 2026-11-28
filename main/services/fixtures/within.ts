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

// Captured at import, before any test enables mock.timers: a poll that waited on
// the mocked setTimeout would never fire.
const realSetTimeout = globalThis.setTimeout;

/** Resolve after `ms`. Looks up the global setTimeout at CALL time, as the
 *  per-file copies did, so a test that mocks setTimeout controls it. */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `ready` every 5 ms until it is true, or throw naming `what` once `ms` of
 * real time pass first.
 *
 * Deadline on performance.now() and the poll on the timer captured at import,
 * so it neither hangs nor expires early in a file that mocks Date or
 * setTimeout (messages-service does both). Arguments are (ready, what, ms) in
 * `what` may be a function so the message names state at the moment of failure.
 */
export async function until(ready: () => boolean | Promise<boolean>, what: string | (() => string), ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  for (;;) {
    if (await ready()) return;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
}

/**
 * `until` for a probe that yields a value: polls `probe` until it returns
 * something truthy and returns it. A probe that throws counts as "not yet", for a
 * wait on something external (a spawned process, a socket) that errors until it
 * is ready. Polls every `pollMs`, for probes that are themselves costly.
 */
export async function untilValue<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  ms = 5000,
  pollMs = 5,
): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const v = await Promise.resolve()
      .then(probe)
      .catch(() => undefined);
    if (v) return v;
    if (performance.now() > deadline) throw new Error(`gave up after ${ms} ms waiting for ${what}`);
    await new Promise<void>((resolve) => realSetTimeout(resolve, pollMs));
  }
}
