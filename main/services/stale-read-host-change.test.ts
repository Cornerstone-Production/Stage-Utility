// A read overtaken by a host change must not act.
//
// configure() calls restart(), which is stop() then start() in the same tick,
// so `running` goes false and straight back to true. A poll parked on its
// request against the OLD host resumes, sees `running === true`, and carries on
// as if it spoke for the new one. REAPER, Resi, YouTube and Smaart guarded with
// `running` alone, so:
//
//   - a failure against the old box wrote "Can't reach <old>" onto the NEW
//     host's row, blanked every display (goOffline) and replaced the new host's
//     healthy poll timer with a back-off;
//   - a success against the old box was published as the new box's state.
//
// The guard is the base's run counter (integration-base.ts `current(run)`):
// bumped by every stop(), captured before the await, checked after it.

import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";

import { reaperDeps, reaperService } from "./reaper-service.js";

const transport = (playstate: number) => `TRANSPORT\t${playstate}\t1.0\t0\t0:01.000\t1.1.00`;
const answer = (body: string) => ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

const realFetch = reaperDeps.fetch;
afterEach(() => {
  reaperDeps.fetch = realFetch;
  reaperService.setConnectionListener(() => {});
  reaperService.configure("", 0);
  reaperService.stop();
});

/** Spin the event loop (setImmediate is not mocked) a fixed number of turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Point REAPER at old.example with its read held open, then at new.example,
 * which answers at once with `newPlaystate`. Returns the held read's handles.
 */
async function overtaken(t: TestContext, newPlaystate: number) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settleOld!: { resolve: (r: Response) => void; reject: (e: Error) => void };
  reaperDeps.fetch = ((input: unknown) => {
    const url = String(input);
    if (url.includes("old.example")) {
      return new Promise<Response>((resolve, reject) => {
        settleOld = { resolve, reject };
      });
    }
    return Promise.resolve(answer(transport(newPlaystate)));
  }) as typeof fetch;

  const reports: { state: string; message: string | null }[] = [];
  reaperService.setConnectionListener((state, message) => reports.push({ state, message }));
  reaperService.configure("old.example", 8080);
  await settle();
  reaperService.configure("new.example", 8080);
  await settle();
  assert.equal(reaperService.getLatest().connected, true, "the new host answered");
  return { settleOld, reports };
}

test("REAPER: a failure from the host the operator moved away from is not the new host's", async (t) => {
  const { settleOld, reports } = await overtaken(t, 0);

  settleOld.reject(new Error("connect ECONNREFUSED"));
  await settle();

  assert.deepEqual(
    reports.filter((r) => r.state === "error"),
    [],
    "the old host's failure was reported on the new host's row",
  );
  assert.equal(reaperService.getLatest().connected, true, "the old host's failure blanked the new host's displays");
});

test("REAPER: an answer from the host the operator moved away from is not published", async (t) => {
  // The new box is stopped (0); the old one was recording (5).
  const { settleOld } = await overtaken(t, 0);

  settleOld.resolve(answer(transport(5)));
  await settle();

  assert.equal(reaperService.getLatest().recording, false, "the old box's transport was published as the new one's");
});

// ── Resi: what a stale run CACHES, not just what it publishes ────────────────
//
// Dropping the stale publish is not enough when the read writes a cache on its
// way. configure() with new credentials clears the cached token; the old
// account's sign-in, still in flight, then wrote its token back, and every
// later poll read the OLD account's encoders until that token expired.

test("Resi: a sign-in for the replaced account does not leave its token behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { resiService } = await import("./resi-service.js");
  const realGlobalFetch = globalThis.fetch;
  let releaseOld!: () => void;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.endsWith("/auth/token")) {
      const { username } = JSON.parse(String(init?.body)) as { username: string };
      if (username === "old") {
        await new Promise<void>((r) => {
          releaseOld = r;
        });
        return json({ access_token: "old-token", expires_in: 3600 });
      }
      return json({ access_token: "new-token", expires_in: 3600 });
    }
    if (url.endsWith("/users/me")) return json({ customerId: "c1" });
    return json([]);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realGlobalFetch;
    resiService.stop();
  });

  resiService.configure("old", "pw");
  await settle();
  resiService.configure("new", "pw");
  await settle();
  releaseOld();
  await settle();

  assert.equal(
    (resiService as unknown as { token: string | null }).token,
    "new-token",
    "the replaced account's token was cached for the new one",
  );
});
