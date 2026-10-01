// video-proxy-routes.ts — WHEP, WHIP and HLS, forwarded to the relay's
// loopback-only HTTP listeners on Stage Utility's own origin.
//
// mediamtx-config.ts binds every relay HTTP listener to 127.0.0.1, so this is
// the only way a browser or OBS ever reaches them: `/video/<feedId>/whep[/<session>]`,
// `/video/<feedId>/whip[/<session>]` and `/video/<feedId>/<file>.m3u8|.mp4|.m4s`,
// each forwarded to 127.0.0.1:<port> for that feed and that kind (videoService's
// relayTarget()).
//
// Runs in EARLY_ROUTE_MODULES (remote-server.ts): none of these paths start
// with /api/, so if this ran after static serving the SPA fallback would
// swallow every one of them before this module ever saw the request.
//
// Every route must finish responding before it returns (see RouteCtx) — the
// upstream call is always awaited, never fired and left to reply later.

import * as http from "node:http";

import { errorMessage } from "../errors.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { PULL_START_TIMEOUT_MS } from "../video/reconcile-plan.js";
import { videoService } from "../video/video-service.js";
import { type RouteCtx, error, readRawBody } from "./context.js";

/**
 * WHEP/WHIP and HLS timeouts — mutable so a test can shrink one to
 * milliseconds rather than actually waiting 10 s or 30 s for it (see
 * video-proxy-routes.test.ts's timeout tests), the same seam
 * video-service.ts's own `videoPollDeps` is for its poll interval.
 * Restored by every test that touches it; production never assigns to it.
 */
export const proxyTimeouts = {
  /** WHEP/WHIP signalling is a handful of round trips over an SDP
   *  offer/answer, but a WHEP offer for an on-demand pull feed is also held
   *  while the relay dials the device, up to PULL_START_TIMEOUT_MS. The
   *  margin past that window is what lets the relay's own answer through —
   *  "source of path 'box' has timed out" names the device; cut off at the
   *  same instant it read as "the video relay did not answer in time", and
   *  sent the operator to the wrong box. Still short enough that a hung
   *  relay is reported rather than left to hold the request open. */
  whepWhip: PULL_START_TIMEOUT_MS + 5_000,
  /** LL-HLS's blocking playlist reload holds the request open until the
   *  next part is ready — the tests' fixture holds for 2 s. 30 s
   *  covers a real stall without the client waiting forever on a relay
   *  that has hung. */
  hls: 30_000,
};
/** A WHEP/WHIP body is an SDP offer/answer, at most a few KB. 64 KB is
 *  headroom for that, not an invitation to send more — see context.ts's own
 *  MAX_* constants for the reasoning: an unauthenticated LAN POST must never
 *  accumulate without bound. */
const MAX_PROXY_BODY_BYTES = 64 * 1024;

/** MediaMTX's WHEP/WHIP session ids are UUIDs. A REQUEST session outside
 *  this is "invalid" before it ever becomes an upstream path segment (a
 *  `/whep/<session>` whose session carries a `/` could otherwise smuggle a
 *  second path segment into the upstream request); an ANSWER's Location
 *  carrying a session outside this is dropped rather than forwarded
 *  verbatim onto a browser — see rewriteLocation. */
const SESSION_PATTERN = /^[A-Za-z0-9-]+$/;
/** The three extensions MediaMTX's HLS server answers. No `/` in the class, so a percent-encoded traversal
 *  attempt (`..%2Fsecret.m3u8`) fails this outright: the `%` is not in it. */
const HLS_FILE_PATTERN = /^[A-Za-z0-9_.-]+\.(m3u8|mp4|m4s)$/;

const PREFIX = "/video/";

type Parsed =
  | { feedId: string; kind: "whep" | "whip"; session: string | null }
  | { feedId: string; kind: "hls"; file: string };

/**
 * Split `/video/<feedId>/<rest>` into a feed id and what it is asking for.
 *
 * Three outcomes, not two, because "not ours" and "ours, but garbage" answer
 * differently:
 *
 *   - "unclaimed" — the path is not this module's shape at all (no `/video/`
 *     prefix, or nothing after the feed id). Falls through to the next
 *     module and, past static serving, the app's own SPA shell — the normal
 *     "not handled" contract every route module shares (see RouteCtx).
 *   - "invalid" — the path HAS the `/video/<feedId>/<tail>` shape but the
 *     tail names no real kind (a `whep`/`whip` session id outside
 *     SESSION_PATTERN, or a file outside HLS_FILE_PATTERN). Left as
 *     "unclaimed" this would fall through past static serving into the SPA
 *     shell, which answers 200 with the whole app rather than a 404 — the
 *     path IS this module's territory and this module says so.
 *   - a Parsed request — refused or forwarded from here, by relayTarget().
 *
 * `pathname` is what `new URL(req.url, base)` already produced (remote-server.ts,
 * and this module's own test harness both build it the same way), which
 * collapses a `..` segment before this ever runs — confirmed against Node's
 * URL parser AND, because a raw client is not obliged to go through that
 * parser client-side the way `fetch` does, against a raw `http.request`
 * whose `path` option is sent unnormalized: the server's own `new URL()`
 * still collapses it on the way in (video-proxy-routes.test.ts's own
 * traversal cases drive exactly that, through a real socket, not a
 * client library that would normalize the attempt away before ever
 * sending it). So `/video/cam/../../v3/paths/list` arrives here as
 * `/v3/paths/list`, "unclaimed" by construction — there is no separate
 * traversal case to parse for at THIS layer; a `%`-encoded attempt that
 * survives normalization (`..%2Fsecret.m3u8`) is what HLS_FILE_PATTERN and
 * SESSION_PATTERN exist to refuse instead.
 */
function parseRequest(pathname: string): Parsed | "unclaimed" | "invalid" {
  if (!pathname.startsWith(PREFIX)) return "unclaimed";
  const rest = pathname.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return "unclaimed"; // no feed id, or no sub-path at all
  const feedId = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (tail === "") return "unclaimed";

  for (const kind of ["whep", "whip"] as const) {
    if (tail === kind) return { feedId, kind, session: null };
    if (tail.startsWith(`${kind}/`)) {
      const session = tail.slice(kind.length + 1);
      return SESSION_PATTERN.test(session) ? { feedId, kind, session } : "invalid";
    }
  }
  return HLS_FILE_PATTERN.test(tail) ? { feedId, kind: "hls", file: tail } : "invalid";
}

/** The upstream request path a target's base is extended into, for one
 *  parsed request. */
function upstreamPath(target: { path: string }, parsed: Parsed, search: string): string {
  if (parsed.kind === "hls") return `${target.path}/${parsed.file}${search}`;
  return parsed.session ? `${target.path}/${parsed.session}` : target.path;
}

/**
 * A `Location` MediaMTX itself sends is relative to ITS OWN root — WHEP/WHIP
 * creation answers `Location: /<path>/whep/<uuid>`, and the
 * HLS listener answers its OWN redirect the same way: a plain
 * `GET /<path>/index.m3u8` comes back `302` to `/<path>/index.m3u8?cookieCheck=1`
 * with a `Set-Cookie` — undocumented anywhere until this proxy's own drive
 * against the real v1.21.1 binary hit it.
 * Either shape must read back on Stage Utility's own origin: the WHEP
 * player resolves its DELETE against whatever URL it POSTed to, and a
 * browser resolves a redirect against the CURRENT origin, which is Stage
 * Utility's, not the relay's loopback port it can never reach directly.
 *
 * For `whep`/`whip` the WHOLE shape is checked — `/<feedId>/<kind>/<session>`,
 * with `session` validated against SESSION_PATTERN — not only the leading
 * `/<feedId>/`: a prefix-only check would forward a malformed Location the
 * relay never actually documented as answering with, verbatim, onto a
 * browser. HLS has no session segment of its own to check this way (a
 * cookie-check redirect's target is a filename and a query string, not a
 * UUID), so only the feed-id prefix applies there.
 */
function rewriteLocation(location: string, feedId: string, kind: "whep" | "whip" | "hls"): string | null {
  const prefix = `/${feedId}/`;
  if (!location.startsWith(prefix)) return null;
  if (kind === "hls") return `/video/${location.slice(1)}`;
  const rest = location.slice(prefix.length);
  const kindPrefix = `${kind}/`;
  if (!rest.startsWith(kindPrefix)) return null;
  const session = rest.slice(kindPrefix.length);
  return SESSION_PATTERN.test(session) ? `/video/${location.slice(1)}` : null;
}

/** One shared log, keyed per feed: a relay outage touching five feeds is five
 *  independent facts (a viewer of feed A gets no news about feed B), and a
 *  flapping relay for one feed still collapses to one line per outage rather
 *  than one per request — the same shape video-service.ts's own pollOutage
 *  uses for the relay-status poll. Exported so a test can shrink its settle
 *  window (settleAfter()) and clear it between cases (forget()), the same
 *  way video-service.test.ts reaches its own OutageLog through a cast —
 *  this one needs no cast, being a plain module binding rather than a
 *  private class field. */
export const proxyOutage = new OutageLog();

function reportProxyFailure(feedId: string, err: unknown): void {
  const message = errorMessage(err);
  const decision = proxyOutage.fail(feedId, message, Date.now());
  if (decision.log) {
    console.warn(`[video] proxy to relay failed for ${scrub(feedId)}: ${scrub(message)}${scrub(decision.note)}`);
  }
}

function reportProxyRecovered(feedId: string): void {
  const decision = proxyOutage.ok(feedId, Date.now());
  if (decision.log) {
    console.log(`[video] proxy to the relay for ${scrub(feedId)} is answering again${scrub(decision.note)}`);
  }
}

/** Headers this proxy forwards to the relay, and nothing else — a WHEP/WHIP
 *  body's Content-Type, OBS's WHIP Authorization Bearer token, and whatever
 *  cookie the relay's own HLS listener set on an earlier request (its
 *  cookie-check redirect and per-session cookie both round-trip through
 *  this — see rewriteLocation's own comment). */
function forwardedHeaders(req: http.IncomingMessage, bodyLength: number | null): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const contentType = req.headers["content-type"];
  if (contentType) headers["content-type"] = contentType;
  const authorization = req.headers["authorization"];
  if (authorization) headers["authorization"] = authorization;
  const cookie = req.headers.cookie;
  if (cookie) headers.cookie = cookie;
  if (bodyLength !== null) headers["content-length"] = String(bodyLength);
  return headers;
}

/**
 * Forward one request to the relay and stream its answer straight back —
 * `upstreamRes.pipe(res)` with no buffering in between, which is what lets
 * an LL-HLS blocking-reload response sit open for seconds without this
 * holding the whole body in memory first.
 *
 * A relay failure is reported through reportProxyFailure() whether it
 * happens before the upstream connects (upstreamReq's own "error") or after
 * (upstreamRes's, a relay dying mid-segment) — EXCEPT when the VIEWER left
 * first: `clientGone` is set the moment this proxy's own response closes,
 * before the upstream request is torn down as a result, so the failure that
 * destroying it then raises is never mistaken for the relay's own. A viewer
 * navigating off mid-hold is not news about the relay.
 *
 * An upstream error before any header has reached the client is a 502 with
 * the message; once headers are sent, the status line is already committed
 * and the only honest move left is to tear the response down.
 */
function forwardToUpstream(
  c: RouteCtx,
  target: { host: "127.0.0.1"; port: number },
  path: string,
  timeoutMs: number,
  body: Buffer | null,
  feedId: string,
  kind: "whep" | "whip" | "hls",
): Promise<void> {
  return new Promise((resolve) => {
    const { req, res, method } = c;
    let clientGone = false;
    const upstreamReq = http.request(
      {
        host: target.host,
        port: target.port,
        path,
        method,
        headers: forwardedHeaders(req, body ? body.length : null),
        timeout: timeoutMs,
      },
      (upstreamRes) => {
        reportProxyRecovered(feedId);
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const h of ["content-type", "content-length", "etag", "set-cookie"]) {
          const v = upstreamRes.headers[h];
          if (v !== undefined) outHeaders[h] = v;
        }
        const location = upstreamRes.headers.location;
        const rewritten = typeof location === "string" ? rewriteLocation(location, feedId, kind) : null;
        if (rewritten) outHeaders.location = rewritten;
        // A playlist or segment must never be cached: LL-HLS advances the
        // same file names across a stream's lifetime.
        if (kind === "hls") outHeaders["cache-control"] = "no-store";
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on("error", (err) => {
          // A relay dying mid-segment IS news, same as a failure before any
          // header went out — reported through the SAME outage key, unless
          // this is really the viewer's own departure surfacing here (the
          // close handler below destroyed upstreamReq, which can carry the
          // failure through to the response it already started).
          if (!clientGone) reportProxyFailure(feedId, err);
          res.destroy();
          resolve();
        });
        res.on("finish", resolve);
        res.on("close", resolve);
      },
    );
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("The video relay did not answer in time"));
    });
    upstreamReq.on("error", (err) => {
      // The client leaving first is the ordinary shape a held HLS request
      // ends in — the close handler below sets clientGone and destroys
      // this same request, which is what raises this error. Nothing here
      // is news about the RELAY, so it is not reported, and — since the
      // response is already gone with the client — not answered either.
      if (clientGone) {
        resolve();
        return;
      }
      reportProxyFailure(feedId, err);
      if (res.headersSent || res.writableEnded || res.destroyed) res.destroy();
      else error(res, errorMessage(err), 502);
      resolve();
    });
    // A client that goes away mid-stream — a screen navigating off, a
    // held LL-HLS reload the browser gave up on — must not leave the
    // upstream half of the pipe running. Harmless once the exchange has
    // already finished normally: destroying an ended request is a no-op,
    // and clientGone is checked above, not acted on again here.
    res.on("close", () => {
      clientGone = true;
      upstreamReq.destroy();
    });
    if (body) upstreamReq.end(body);
    else upstreamReq.end();
  });
}

export async function videoProxyRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, url, method } = c;
  const parsed = parseRequest(pathname);
  if (parsed === "unclaimed") return;
  if (parsed === "invalid") {
    error(res, "Not found", 404);
    return;
  }

  const target = videoService.relayTarget(parsed.feedId, parsed.kind);
  if ("refuse" in target) {
    error(res, target.refuse === 503 ? target.error : "Not found", target.refuse);
    return;
  }

  // A playlist or segment is only ever read, never written — MediaMTX's
  // HLS listener has nothing else to do with a POST/PUT/DELETE, and
  // forwarding one anyway would be handing an arbitrary method through to
  // a listener nothing here has reason to trust with one. Refused before
  // the body is even read, so nothing reaches the relay either way.
  if (parsed.kind === "hls" && method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Buffered, not piped: the only way to guarantee an over-cap body "never
  // reaches upstream" is to finish reading it before the
  // upstream connection even opens. Safe to buffer at this size — an SDP
  // offer/answer is a few KB — unlike the HLS response path below, which
  // streams because a held blocking-reload response can run to seconds.
  const body = parsed.kind === "hls" ? null : Buffer.from(await readRawBody(req, MAX_PROXY_BODY_BYTES));

  // Demand is recorded AFTER the body check (an over-cap POST never reaches
  // here at all — readRawBody has already thrown) and only for the two
  // requests that actually mean "someone is asking to watch": a WHEP POST
  // creating a session, and a playlist GET — never a DELETE/PATCH against
  // an existing session, a WHIP push, or a segment fetch, none of which say
  // anything new about a VIEWER's demand. relayTarget() above has already
  // confirmed `parsed.feedId` names a real feed this kind can serve, so
  // markRequested() needs no validation of its own — see its own comment.
  const isWhepCreate = parsed.kind === "whep" && parsed.session === null && method === "POST";
  const isPlaylistGet = parsed.kind === "hls" && parsed.file.endsWith(".m3u8") && method === "GET";
  if (isWhepCreate || isPlaylistGet) videoService.markRequested(parsed.feedId);

  const path = upstreamPath(target, parsed, url.search);
  const timeoutMs = parsed.kind === "hls" ? proxyTimeouts.hls : proxyTimeouts.whepWhip;
  await forwardToUpstream(c, target, path, timeoutMs, body, parsed.feedId, parsed.kind);
}
