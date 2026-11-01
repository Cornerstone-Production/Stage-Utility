// A fetch stub that holds every request until the test releases it, so a test can
// choose the order responses land in. Records how many were ever in flight at
// once. Shared by the two subscribe-report tests (shared worker and api.ts).

export interface HeldRequest {
  url: string;
  body: string;
  signal: AbortSignal | undefined;
  respond: () => void;
  fail: (err: Error) => void;
}

export function heldFetch() {
  const outstanding: HeldRequest[] = [];
  const sent: HeldRequest[] = [];
  const state = {
    outstanding,
    sent,
    maxConcurrent: 0,
    /** Let promise continuations (the reporter's .finally) run. */
    settle: () => new Promise<void>((r) => setImmediate(r)),
    fetch: (url: string, init?: { body?: string; signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const req: HeldRequest = {
          url: String(url),
          body: init?.body ?? "",
          signal: init?.signal,
          respond: () => {
            outstanding.splice(outstanding.indexOf(req), 1);
            resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
          },
          fail: (err) => {
            outstanding.splice(outstanding.indexOf(req), 1);
            reject(err);
          },
        };
        outstanding.push(req);
        sent.push(req);
        state.maxConcurrent = Math.max(state.maxConcurrent, outstanding.length);
      }),
  };
  return state;
}
