// client-log-routes.ts — POST /api/log/client, so a browser failure reaches /log.
//
// The renderer logs plenty of real failures — a record that would not load, a
// preference that would not save — and every one of them went to the browser's
// own console, which nobody has open. An operator debugging at 9am on a Sunday
// reads `/log`, and until this route existed the only evidence of a failed fetch
// was a blank widget.
//
// NOT A GENERAL LOG SINK. It takes a tag and one message, writes one line, and
// stops taking them if a client sends too many. Everything a page might want to
// say in a loop belongs in the loop's own state, not here.
//
// On forgery: the app is LAN-trusted and has no auth, so anything that can reach
// this port can already reach every mutating route on it. This adds no exposure
// the rest of `/api` does not already carry. What it DOES have to prevent is a
// forged LINE — a newline in the message would write a second entry
// indistinguishable from the server's own — which is what `scrub` is for, and a
// client spinning the buffer, which is what the rate limit is for.

import { scrub } from "../scrub.js";
import { type RouteCtx, error, json, readBodyOrEmpty } from "./context.js";

/** A tag the log page can filter on: the same shape the server's own tags have.
 *  Bounded, so a client cannot write a 4KB `[…]` prefix. */
const TAG = /^[a-z][a-z0-9-]{0,23}$/;

/** How much of a client's message reaches a line. `scrub` caps interpolated
 *  values at 200; a whole message may be a little longer. */
const MAX_MESSAGE = 300;

/** The window, and how many lines one client may write in it.
 *
 *  Ten is enough for a page that fails to load several things at once — the
 *  History day list logs one line per SPL record it could not read — and far
 *  too few to push anything out of a 10,000-line buffer. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

/**
 * Per-client counters.
 *
 * A Map keyed by the client address, never a plain object: a request-controlled
 * key on an object is the remote-property-injection shape this repo has had
 * CodeQL alerts for, and `__proto__` as a key is a real address to nobody but
 * still a real property to an object.
 */
const seen = new Map<string, { count: number; until: number }>();

/**
 * Who is asking, for the rate limit only. Never logged — it is a LAN address and
 * this repository is public.
 *
 * Optional all the way down. A request without a socket is not something a real
 * server hands over, but a route that THROWS while trying to work out whom to
 * throttle has turned a diagnostic into an outage; everything unattributable
 * shares one bucket, which is the safe direction to be wrong in.
 */
function clientKey(c: RouteCtx): string {
  return c.req.socket?.remoteAddress ?? "unknown";
}

/**
 * Whether this client may write another line, and whether this is the first
 * refusal in the window.
 *
 * The first refusal writes ONE line of its own, so a client that goes quiet
 * because it was throttled does not read as a client that stopped failing.
 * Silence with no explanation is the thing this whole route exists to fix.
 */
function allow(key: string, now: number): { ok: boolean; firstRefusal: boolean } {
  const hit = seen.get(key);
  if (!hit || now >= hit.until) {
    seen.set(key, { count: 1, until: now + WINDOW_MS });
    return { ok: true, firstRefusal: false };
  }
  hit.count += 1;
  if (hit.count <= MAX_PER_WINDOW) return { ok: true, firstRefusal: false };
  return { ok: false, firstRefusal: hit.count === MAX_PER_WINDOW + 1 };
}

/** Test seam: the counters are process-global, and one test's flood is another
 *  test's starting state. */
export function resetClientLogLimits(): void {
  seen.clear();
}

export async function clientLogRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
  if (method !== "POST" || pathname !== "/api/log/client") return;

  const body = await readBodyOrEmpty(req);
  const tag = typeof body.tag === "string" ? body.tag : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!TAG.test(tag)) {
    error(res, "body.tag must be a short lower-case tag, e.g. \"history\"");
    return;
  }
  if (!message) {
    error(res, "body.message (a non-empty string) required");
    return;
  }

  const { ok, firstRefusal } = allow(clientKey(c), Date.now());
  if (!ok) {
    if (firstRefusal) {
      // `scrub(tag)` even though TAG has already refused anything with a
      // newline in it: a validated value interpolated raw is the shape the
      // log-injection scan refuses, and it is right to — the validation and the
      // interpolation are five lines apart today and could be five files apart
      // tomorrow.
      //
      // The limit itself is NOT interpolated. Every `${…}` on a console line in
      // this tree has to go through scrub, and wrapping a module constant in it
      // to satisfy a scan would be gaming the scan rather than obeying it. The
      // number is on MAX_PER_WINDOW, a few lines up, for whoever needs it.
      console.warn(`[${scrub(tag)}] a browser is logging faster than this route accepts; the rest of the minute is dropped`);
    }
    // 429, not a silent 200: a client that is being throttled should be able to
    // tell, and stop rather than keep sending.
    error(res, "too many client log lines; try again shortly", 429);
    return;
  }

  // `warn`, always. A browser does not get to claim a line is an error the
  // server raised, and nothing that reaches this route is routine enough to be
  // `log`. Scrubbed, because the message is caller-supplied.
  console.warn(`[${scrub(tag)}] ${scrub(message.slice(0, MAX_MESSAGE))}`);
  json(res, { ok: true });
}
