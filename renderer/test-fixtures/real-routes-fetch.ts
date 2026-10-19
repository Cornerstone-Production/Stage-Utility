// real-routes-fetch.ts — a fetch that answers from the REAL server route modules.
//
// A renderer test that stubs fetch proves the page against the stub, and the stub
// is whatever its author thought the server says. This one hands each request to
// the real route (through route-harness, no socket) so the page is proved against
// the bytes a server sends: the rules route's 409s and issues, the views route's
// revision check, the cue route's cooldown.
//
// Routes are PASSED IN rather than imported here: the engine and stage controller
// read STAGE_UTILITY_DATA when they load, so the test sets it, then imports them,
// then calls this.
//
// TEST-ONLY: no `.test.` in the filename on purpose, so `npm test`'s glob does not
// pick this up as a (zero-test) suite of its own.

import type { RouteCtx } from "../../main/services/routes/context.js";
import type { Captured, RequestOptions } from "../../main/services/routes/route-harness.js";

type Route = (c: RouteCtx) => Promise<void>;

/** What the app's own page sends: an Origin naming this server. */
export const BROWSER = { origin: "http://stage.local:8788", host: "stage.local:8788" };

export interface RealRoutes {
  /** Every write the page sent, in order. */
  writes: { method: string; url: string; body: string | null }[];
  /** While set, a write whose URL starts with `view` is held AFTER it has landed,
   *  so a test can look at the page between the write and its answer. */
  holdWritesTo: { prefix: string; until: Promise<void> } | null;
}

/** Install the bridge as `globalThis.fetch`. A path under none of `routes` answers
 *  200 `{}`, which is what the page's incidental reads (plan items, targets) need. */
export function installRealRoutesFetch(
  routes: { prefix: string | RegExp; handler: Route }[],
  callRoute: (route: Route, path: string, opts?: RequestOptions) => Promise<Captured>,
): RealRoutes {
  const state: RealRoutes = { writes: [], holdWritesTo: null };
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = url.split("?")[0];
    if (method !== "GET") state.writes.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    const hit = routes.find((r) => (typeof r.prefix === "string" ? path.startsWith(r.prefix) : r.prefix.test(path)));
    const out = hit
      ? await callRoute(hit.handler, url, {
          method,
          headers: BROWSER,
          ...(typeof init?.body === "string" && init.body ? { body: JSON.parse(init.body) } : {}),
        })
      : { status: 200, json: {}, body: "{}" };
    if (method !== "GET" && state.holdWritesTo && path.startsWith(state.holdWritesTo.prefix)) {
      await state.holdWritesTo.until;
    }
    const status = out.status ?? 500;
    return {
      ok: status < 400,
      status,
      statusText: String(status),
      json: async () => out.json,
      text: async () => out.body,
    };
  };
  return state;
}
